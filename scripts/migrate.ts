// Build-time migration runner. We can't use `prisma db push` here
// because the Vercel build env doesn't have a DIRECT_URL set (the
// pooled DATABASE_URL works for the runtime Prisma client but tripped
// `db push` during testing — see commit 40016ad). Instead we apply
// idempotent additive migrations through the same connection the app
// uses. Add new ALTER statements here when the schema grows.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function ensureNotifyColumns(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "User"
      ADD COLUMN IF NOT EXISTS "notifyMain"  BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "notifyNew"   BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "notifyOther" BOOLEAN NOT NULL DEFAULT true;
  `);
}

async function main() {
  console.log("[migrate] start");
  await ensureNotifyColumns();
  console.log("[migrate] done");
}

main()
  .catch((e) => {
    console.error("[migrate] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
