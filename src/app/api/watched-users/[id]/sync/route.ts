// POST /api/watched-users/:id/sync
//
// Re-fetches the watched user's profile + public playlists. Newly-
// discovered playlists land in section="new" and trigger one push
// notification each ("X just shared a new playlist: Y"). Already-tracked
// playlists are left in their current section (we never auto-demote a
// promoted Main playlist).
//
// Cooldown-gated: zero Spotify calls if we're inside a 429 window.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { getCooldownSeconds } from "@/lib/rate-limit";
import { syncWatchedUser } from "@/lib/watched-user-sync";
import { SpotifyError } from "@/lib/spotify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const cooldown = await getCooldownSeconds();
  if (cooldown > 0) {
    return NextResponse.json({
      ok: true,
      skipped: "cooldown",
      cooldownSeconds: cooldown,
    });
  }

  const watchedUser = await prisma.watchedUser.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!watchedUser) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const result = await syncWatchedUser(user, watchedUser.spotifyId);
    return NextResponse.json({
      ok: true,
      watchedUser: {
        id: result.watchedUser.id,
        spotifyId: result.watchedUser.spotifyId,
        displayName: result.watchedUser.displayName,
        imageUrl: result.watchedUser.imageUrl,
        lastSyncedAt: result.watchedUser.lastSyncedAt,
      },
      added: result.added,
      total: result.total,
      truncated: result.truncated,
      notificationsSent: result.notificationsSent,
    });
  } catch (e) {
    if (e instanceof SpotifyError) {
      return NextResponse.json(
        { error: e.message, status: e.status },
        { status: e.status === 404 ? 404 : 502 },
      );
    }
    console.error("[POST /api/watched-users/:id/sync] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
