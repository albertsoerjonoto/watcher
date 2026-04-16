import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { pollPlaylist } from "@/lib/poll";
import { getCooldownSeconds } from "@/lib/rate-limit";

// POST /api/playlists/:id/retry
//
// Resets a playlist to "active" and runs a fresh poll immediately.
// Used by the dashboard's "Retry" button so the user doesn't have to
// re-paste the URL when a previous poll errored.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  // Don't fire Spotify calls during a cooldown — the dashboard Retry
  // button shouldn't generate noisy PollLog rows while we're blocked.
  const cd = await getCooldownSeconds();
  if (cd > 0) {
    return NextResponse.json(
      { error: "rate-limited", cooldownSeconds: cd },
      { status: 429 },
    );
  }

  const playlist = await prisma.playlist.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!playlist) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Clear snapshotId so the next poll always re-fetches tracks. Without
  // this, a Retry on a playlist that was seeded with zero tracks would
  // hit the snapshot short-circuit and do nothing.
  const reset = await prisma.playlist.update({
    where: { id: playlist.id },
    data: { status: "active", snapshotId: null },
  });

  try {
    const result = await pollPlaylist(user, reset);
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message.slice(0, 500) },
      { status: 500 },
    );
  }
}
