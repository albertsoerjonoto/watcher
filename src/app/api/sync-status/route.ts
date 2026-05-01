// GET /api/sync-status
//
// Pure-DB read used by the client AutoRefresh widget to decide whether
// to POST /api/refresh. Returns the current Spotify cooldown (in seconds)
// and the count of playlists whose lastCheckedAt is stale enough to
// warrant a poll. Crucially, this endpoint NEVER calls Spotify — if
// the client used /api/refresh to ask "anything to do?" we'd hit Spotify
// on every dashboard mount, which is exactly how we got rate-limited
// the first time.
//
// The client reads this, renders the cooldown banner from it, and only
// fires a real refresh if cooldown === 0 AND stalePlaylists > 0.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getCooldownSeconds } from "@/lib/rate-limit";
import { STALE_THRESHOLD_MS } from "@/lib/stale";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  // Only count Main + New as "stale" — those are the sections AutoRefresh
  // can actually refresh via /api/refresh. Other has its own 12h gate
  // on the cron path; counting it here would make the widget perpetually
  // think there's something to refresh when there isn't.
  const [cooldownSeconds, staleCount, totalActive] = await Promise.all([
    getCooldownSeconds(),
    prisma.playlist.count({
      where: {
        userId: user.id,
        status: "active",
        section: { in: ["main", "new"] },
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: new Date(Date.now() - STALE_THRESHOLD_MS) } },
        ],
      },
    }),
    prisma.playlist.count({
      where: {
        userId: user.id,
        status: "active",
        section: { in: ["main", "new"] },
      },
    }),
  ]);

  return NextResponse.json({
    cooldownSeconds,
    staleCount,
    totalActive,
    staleThresholdMinutes: Math.round(STALE_THRESHOLD_MS / 60_000),
  });
}
