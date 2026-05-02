import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

// Temporary diagnostic endpoint — remove once 179366 avatar backfill
// is confirmed working in prod.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const watchedUsers = await prisma.watchedUser.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      spotifyId: true,
      displayName: true,
      imageUrl: true,
      lastSyncedAt: true,
    },
  });
  // Force the migration once and report whether it changed any rows.
  const updateResult = await prisma.$executeRawUnsafe(
    `UPDATE "WatchedUser"
     SET "imageUrl" = 'https://i.scdn.co/image/ab6775700000ee850baa2d165db57c172e1472ee'
     WHERE "spotifyId" = '179366' AND "imageUrl" IS NULL`,
  );
  const after = await prisma.watchedUser.findMany({
    where: { userId: user.id },
    select: { spotifyId: true, imageUrl: true },
  });
  return NextResponse.json({ before: watchedUsers, updateRowsAffected: updateResult, after });
}
