// POST /api/playlists/poll-pending
//
// Polls the next batch of never-polled playlists for the signed-in
// user. Returns counts so the client can call this in a loop until
// `remaining` is 0 (or `skipped: "cooldown"` fires, in which case the
// client should pause for `cooldownSeconds` and retry).
//
// Why this exists:
//   When a watched user is synced, 50+ Other-section playlists can be
//   added at once. /api/refresh skips Other-section by design (12h
//   staleness) and the cron job is once-per-day on Vercel Hobby. So
//   without this endpoint, those playlists sit on "Loading…" until the
//   next cron tick. This endpoint is the user-facing way to drain the
//   first-poll queue immediately, batch by batch, gated on the same
//   rate-limit chokepoint as everything else.
//
// Contract:
//   Input: optional { limit: number } — defaults to 5. Capped at 10.
//   Output:
//     - { skipped: "cooldown", cooldownSeconds } if a 429 is active
//     - { skipped: "fresh", polled: 0, remaining: 0 } if nothing to do
//     - { polled, remaining, hitRateLimit, results } otherwise
//
// remaining is the count of playlists STILL pending (lastCheckedAt =
// null) AFTER this batch. Client loops until 0.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { pollPlaylist } from "@/lib/poll";
import { getCooldownSeconds } from "@/lib/rate-limit";
import type { User } from "@prisma/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ limit: z.number().int().positive().max(10).optional() });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const cooldown = await getCooldownSeconds();
  if (cooldown > 0) {
    const remaining = await countPending(user.id);
    return NextResponse.json({
      skipped: "cooldown",
      cooldownSeconds: cooldown,
      remaining,
    });
  }

  const json = await request.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  const limit = parsed.success ? (parsed.data.limit ?? 5) : 5;

  // Pick the next batch of never-polled playlists, regardless of
  // section. Deterministic ordering by createdAt so retries don't
  // starve any one playlist.
  const batch = await prisma.playlist.findMany({
    where: {
      userId: user.id,
      status: "active",
      lastCheckedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  if (batch.length === 0) {
    return NextResponse.json({
      skipped: "fresh",
      polled: 0,
      remaining: 0,
      hitRateLimit: false,
      results: [],
    });
  }

  let u: User = user;
  let hitRateLimit = false;
  const results = [];
  for (const p of batch) {
    const r = await pollPlaylist(u, p);
    results.push({
      playlistId: r.playlistId,
      newTracks: r.newTracks,
      error: r.error ?? null,
    });
    const fresh = await prisma.user.findUnique({ where: { id: u.id } });
    if (fresh) u = fresh;
    if (r.error?.includes("429") || r.error?.includes("cooldown")) {
      hitRateLimit = true;
      break;
    }
  }

  const remaining = await countPending(user.id);
  return NextResponse.json({
    polled: results.length,
    remaining,
    hitRateLimit,
    results,
  });
}

async function countPending(userId: string): Promise<number> {
  return prisma.playlist.count({
    where: { userId, status: "active", lastCheckedAt: null },
  });
}
