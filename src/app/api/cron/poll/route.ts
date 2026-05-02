// Cron endpoint. Call every 10-15 minutes with:
//   Authorization: Bearer $CRON_SECRET
//
// Idempotent: safe to retry. Snapshot check makes repeats cheap.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { pollAllForUser } from "@/lib/poll";
import { getCooldownSeconds } from "@/lib/rate-limit";
import { syncWatchedUser } from "@/lib/watched-user-sync";
import { SpotifyError } from "@/lib/spotify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// How often to retry discovery for watched users whose discoveryStatus
// is "blocked" or "partial". 6h gives Spotify infra time to recover and
// users time to flip privacy settings without burning rate-limit
// budget by re-firing on every cron tick. Hobby-tier crons run daily,
// so in practice this is "next cron tick" until the schedule is
// upgraded; we still gate on it to be correct on Pro.
const DISCOVERY_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Cap retries per cron tick. Worst-case per user: ~12 Spotify calls
// (1 profile + 4 paged user OAuth + 1 spclient profile + 4 paged
// spclient subroute + 3 search). 3 users × 12 = 36 calls, paced by
// 2s sleep between users to stay under the 20-in-30s rolling window.
const MAX_DISCOVERY_RETRIES_PER_TICK = 3;
const DISCOVERY_RETRY_USER_PACING_MS = 2_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  // Vercel strips x-vercel-cron from external requests, so this header
  // is trustworthy when the app is deployed on Vercel. In other
  // environments it could be spoofed, so we still require the Bearer
  // token as a fallback.
  const fromVercel = request.headers.get("x-vercel-cron");
  if (fromVercel && process.env.VERCEL) return true;
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Cooldown guard: if a prior run already earned us a Retry-After,
  // honor it. A cron tick firing into an active 429 window would just
  // re-arm the rolling limit and extend the penalty.
  const cooldown = await getCooldownSeconds();
  if (cooldown > 0) {
    return NextResponse.json({
      ok: true,
      skipped: "cooldown",
      cooldownSeconds: cooldown,
    });
  }
  const users = await prisma.user.findMany();
  const out: Record<string, unknown> = {};
  for (const u of users) {
    out[u.spotifyId] = await pollAllForUser(u);
  }

  // Phase 2 of the cron tick: auto-rediscovery for privacy-locked /
  // partial-discovery watched users. We do this AFTER pollAllForUser
  // so a freshly-poisoned cooldown from the poll phase is honoured
  // here (we re-check at every iteration). New playlists discovered
  // here flow through the existing first-sync / new-section /
  // notification machinery in syncWatchedUser, so users see push
  // notifications when Spotify infra recovers and the search index
  // catches up.
  const rediscoveryReport: Array<{
    userId: string;
    spotifyId: string;
    result?: { added: number; via?: string; status?: string };
    skipped?: string;
    error?: string;
  }> = [];
  const cutoff = new Date(Date.now() - DISCOVERY_RETRY_INTERVAL_MS);
  const stale = await prisma.watchedUser.findMany({
    where: {
      discoveryStatus: { in: ["blocked", "partial"] },
      OR: [
        { lastDiscoveryAttemptAt: null },
        { lastDiscoveryAttemptAt: { lt: cutoff } },
      ],
    },
    take: MAX_DISCOVERY_RETRIES_PER_TICK,
    orderBy: { lastDiscoveryAttemptAt: { sort: "asc", nulls: "first" } },
  });

  for (const wu of stale) {
    // Re-check cooldown each iteration — the poll phase or a previous
    // iteration here may have just earned us a Retry-After.
    const innerCooldown = await getCooldownSeconds();
    if (innerCooldown > 0) {
      rediscoveryReport.push({
        userId: wu.userId,
        spotifyId: wu.spotifyId,
        skipped: `cooldown(${innerCooldown}s)`,
      });
      break; // No point continuing if Spotify wants us quiet
    }
    const owner = users.find((u) => u.id === wu.userId);
    if (!owner) {
      rediscoveryReport.push({
        userId: wu.userId,
        spotifyId: wu.spotifyId,
        skipped: "owner-user-not-found",
      });
      continue;
    }
    try {
      const result = await syncWatchedUser(owner, wu.spotifyId);
      rediscoveryReport.push({
        userId: wu.userId,
        spotifyId: wu.spotifyId,
        result: {
          added: result.added,
          via: result.discoveryVia,
          status: result.privacyLocked ? "blocked" : "ok",
        },
      });
    } catch (e) {
      const msg =
        e instanceof SpotifyError
          ? `${e.status}: ${e.message.slice(0, 200)}`
          : e instanceof Error
            ? e.message.slice(0, 200)
            : "unknown";
      rediscoveryReport.push({
        userId: wu.userId,
        spotifyId: wu.spotifyId,
        error: msg,
      });
    }
    // Pace requests to keep the rolling 30s window honest.
    await sleep(DISCOVERY_RETRY_USER_PACING_MS);
  }

  return NextResponse.json({
    ok: true,
    users: out,
    rediscovery: rediscoveryReport,
  });
}

// Also accept POST for flexibility with some cron providers.
export const POST = GET;
