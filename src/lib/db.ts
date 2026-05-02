import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prismaBase?: PrismaClient;
  watcherMigrations?: Promise<void>;
};

const prismaBase =
  globalForPrisma.prismaBase ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaBase = prismaBase;

// Lazy, idempotent runtime migrations. Vercel doesn't expose
// DATABASE_URL at build time (it's runtime-only by default), so
// `prisma db push` can't run there. Instead we apply additive
// migrations the first time the server touches an affected table.
// Each statement uses IF NOT EXISTS / WHERE-guards so concurrent cold
// starts and re-invocations are safe. The promise is cached on
// globalThis so we only pay this cost once per process.
async function applyMigrations(): Promise<void> {
  // Schema additions (idempotent via IF NOT EXISTS).
  await prismaBase.$executeRawUnsafe(`
    ALTER TABLE "User"
      ADD COLUMN IF NOT EXISTS "notifyMain"  BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "notifyNew"   BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "notifyOther" BOOLEAN NOT NULL DEFAULT true;
  `);

  // One-shot data backfills. Each is gated on the column being null
  // (or another idempotency check) so a successful subsequent
  // /api/watched-users/{id}/sync can overwrite with a fresher value
  // without us clobbering it on the next cold start.
  //
  // displayName=179366 (real spotifyId 31uxjftzzhheqxma2ksjviugtume):
  // Spotify's Web API /users/{id} returns no `images` array for this
  // profile even though the web UI shows an avatar. Until we wire a
  // fallback fetch (spclient or embed) for profile images, backfill
  // the known CDN URL by hand. We match on the long-form spotifyId
  // because displayName="179366" is just a backfilled fallback for
  // privacy-locked users (could collide with other users in theory).
  await prismaBase.$executeRawUnsafe(`
    UPDATE "WatchedUser"
    SET "imageUrl" = 'https://i.scdn.co/image/ab6775700000ee850baa2d165db57c172e1472ee'
    WHERE "spotifyId" = '31uxjftzzhheqxma2ksjviugtume' AND "imageUrl" IS NULL;
  `);
}

export function ensureMigrations(): Promise<void> {
  if (!globalForPrisma.watcherMigrations) {
    globalForPrisma.watcherMigrations = applyMigrations().catch((e) => {
      // Reset on failure so the next request retries. We swallow the
      // error here so a transient migration failure doesn't crash the
      // request — the underlying SELECT will fail loudly if the columns
      // truly aren't there, which is what we want.
      globalForPrisma.watcherMigrations = undefined;
      console.error("[migrate] failed:", e);
    });
  }
  return globalForPrisma.watcherMigrations;
}

// Auto-gate every User and WatchedUser operation behind the migration
// promise. This way callers don't have to remember to call
// ensureMigrations() before each prisma.user.* / prisma.watchedUser.*
// — the extension does it for them. Other models don't need the gate
// (so far we've only touched these two).
export const prisma = prismaBase.$extends({
  query: {
    user: {
      async $allOperations({ args, query }) {
        await ensureMigrations();
        return query(args);
      },
    },
    watchedUser: {
      async $allOperations({ args, query }) {
        await ensureMigrations();
        return query(args);
      },
    },
  },
});
