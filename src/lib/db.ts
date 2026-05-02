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
// migrations the first time the server touches the User table. Each
// ALTER uses IF NOT EXISTS so concurrent cold starts and re-invocations
// are safe — at most one Lambda actually adds the column, the rest
// see it already there. The promise is cached on globalThis so we
// only pay this cost once per process.
async function applyMigrations(): Promise<void> {
  await prismaBase.$executeRawUnsafe(`
    ALTER TABLE "User"
      ADD COLUMN IF NOT EXISTS "notifyMain"  BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "notifyNew"   BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "notifyOther" BOOLEAN NOT NULL DEFAULT true;
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

// Auto-gate every User operation behind the migration. This way
// callers don't have to remember to call ensureMigrations() before
// each prisma.user.* — the extension does it for them. Other models
// don't need the gate (the schema change only touched User).
export const prisma = prismaBase.$extends({
  query: {
    user: {
      async $allOperations({ args, query }) {
        await ensureMigrations();
        return query(args);
      },
    },
  },
});
