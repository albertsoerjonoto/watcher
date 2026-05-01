// POST /api/refresh
//
// Polls active playlists for the signed-in user, BUT only those whose
// lastCheckedAt is older than STALE_THRESHOLD_MS, AND only if we are
// not currently inside a persisted 429 cooldown. Both gates are cheap
// DB reads — we never pay a Spotify round-trip just to decide nothing
// needs refreshing.
//
// Why the double gate (post-mortem):
//
//   Before this fix, opening the dashboard fired /api/refresh, which
//   called pollAllForUser on every active playlist even if we'd polled
//   them 5 seconds ago. Combined with AutoRefresh firing on every
//   tab-focus + visibilitychange, a single afternoon of iteration
//   burned through Spotify's rolling-30s budget and earned us a
//   ~12-hour 429 block. See src/lib/rate-limit.ts for the full
//   post-mortem.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { pollPlaylist } from "@/lib/poll";
import { prisma } from "@/lib/db";
import { getCooldownSeconds } from "@/lib/rate-limit";
import { STALE_THRESHOLD_MS } from "@/lib/stale";
import type { User } from "@prisma/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  // Gate 1: persisted cooldown. If Spotify told any instance "come
  // back in Ns", don't even enumerate the playlists.
  const cooldown = await getCooldownSeconds();
  if (cooldown > 0) {
    return NextResponse.json({
      ok: true,
      skipped: "cooldown",
      cooldownSeconds: cooldown,
      results: [],
    });
  }

  // Gate 2: staleness. A playlist freshly polled 5 seconds ago doesn't
  // need re-polling; skip it. The user can still force a full refresh
  // via the per-playlist Retry button or by waiting for the next tick.
  //
  // Section gate: only refresh Main + New on user-triggered refresh.
  // Other has its own 12h staleness threshold (cron-only) — refreshing
  // 50+ Other-section playlists every time the dashboard mounts would
  // burn the rate-limit budget for no real value (Other doesn't even
  // notify on track adds).
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stale = await prisma.playlist.findMany({
    where: {
      userId: user.id,
      status: "active",
      section: { in: ["main", "new"] },
      OR: [
        { lastCheckedAt: null },
        { lastCheckedAt: { lt: staleCutoff } },
      ],
    },
    // Same deterministic ordering as pollAllForUser: never-checked
    // playlists first, then oldest-checked. Prevents 429 short-circuit
    // from repeatedly starving the same playlists.
    orderBy: [{ lastCheckedAt: "asc" }, { createdAt: "asc" }],
  });

  if (stale.length === 0) {
    return NextResponse.json({ ok: true, skipped: "fresh", results: [] });
  }

  // Sequential to keep rate-limit pressure sane, same as pollAllForUser.
  let u: User = user;
  const results = [] as Array<Awaited<ReturnType<typeof pollPlaylist>>>;
  for (const p of stale) {
    const r = await pollPlaylist(u, p);
    results.push(r);
    const fresh = await prisma.user.findUnique({ where: { id: u.id } });
    if (fresh) u = fresh;
    // If pollPlaylist just hit a 429 we'll have persisted the cooldown
    // inside spotifyGet. Bail out of the loop — every subsequent poll
    // would immediately short-circuit at assertCanCallSpotify anyway,
    // and we may as well return fast.
    if (r.error?.includes("429") || r.error?.includes("cooldown")) break;
  }

  return NextResponse.json({ ok: true, results });
}
