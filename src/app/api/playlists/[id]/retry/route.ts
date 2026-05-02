import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { pollPlaylist } from "@/lib/poll";
import {
  getCooldownSeconds,
  getRefreshBatchThrottleSeconds,
  recordRefreshBatchStarted,
} from "@/lib/rate-limit";

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

  // Cross-instance batch throttle. A user spam-clicking Retry across
  // multiple playlists, or 5 agents racing tests, would otherwise
  // pile Spotify calls into the same 30-second window. The first
  // retry stamps lastRefreshBatchAt; subsequent retries within the
  // throttle window are short-circuited to a 429 with retry-after.
  const throttleSeconds = await getRefreshBatchThrottleSeconds();
  if (throttleSeconds > 0) {
    return NextResponse.json(
      { error: "throttled", retryAfterSeconds: throttleSeconds },
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

  // Stamp the batch BEFORE the first Spotify call so a concurrent
  // caller (different lambda, different tab, different agent) sees
  // it and bails.
  await recordRefreshBatchStarted();
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
