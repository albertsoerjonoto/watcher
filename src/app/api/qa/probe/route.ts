import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Public read-only health probe. The agent loop calls this from
// scripts/qa-prod.ts to verify production beyond "the page didn't
// 500" — we want to know "the cron is still running", "watchedUsers
// have avatars", "the recent polls succeeded", etc., without needing
// a session cookie.
//
// Returns aggregates only (counts, success rates, freshness flags).
// No PII, no tokens, no per-row data.
//
// Rate limit (in-process per Lambda): 1 req per 5s. Probe is cheap
// but doesn't need to run every second — spam protection only.

let lastInvocationAt = 0;
const RATE_WINDOW_MS = 5_000;

const STALE_CRON_MS = 30 * 60 * 60 * 1000; // 30h (cron runs daily on Hobby)
const STALE_SYNC_MS = 14 * 24 * 60 * 60 * 1000; // 14d
// Orphan = playlist row with watchedUserId IS NULL. POST /api/playlists
// creates rows with watchedUserId=null and the post-poll attach hook in
// src/lib/poll.ts:265 wires it up on first successful poll. A row that
// stays orphaned past STUCK_ORPHAN_MS is a sign the retry/drain path is
// broken — exactly the failure mode that bit us when AddPlaylistForm was
// fire-and-forget on /api/playlists/:id/retry.
const STUCK_ORPHAN_MS = 30 * 60 * 1000; // 30 min

type CheckStatus = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

function pickWorst(checks: Check[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

export async function GET() {
  const now = Date.now();
  if (now - lastInvocationAt < RATE_WINDOW_MS) {
    return NextResponse.json(
      { error: "rate-limited", retryAfterMs: RATE_WINDOW_MS },
      { status: 429 },
    );
  }
  lastInvocationAt = now;

  const checks: Check[] = [];

  // 1) Tables exist + counts. Implicitly verifies the lazy migration
  // applied — if the schema is drifted, these queries throw.
  const counts: {
    users?: number;
    watchedUsers?: number;
    playlists?: number;
    tracks?: number;
    pollLogs?: number;
  } = {};
  try {
    const [users, watchedUsers, playlists, tracks, pollLogs] =
      await Promise.all([
        prisma.user.count(),
        prisma.watchedUser.count(),
        prisma.playlist.count(),
        prisma.track.count(),
        prisma.pollLog.count(),
      ]);
    counts.users = users;
    counts.watchedUsers = watchedUsers;
    counts.playlists = playlists;
    counts.tracks = tracks;
    counts.pollLogs = pollLogs;
    checks.push({
      name: "schema.tables",
      status: "ok",
      detail: `users=${users} watchedUsers=${watchedUsers} playlists=${playlists} tracks=${tracks} pollLogs=${pollLogs}`,
    });
  } catch (e) {
    checks.push({
      name: "schema.tables",
      status: "fail",
      detail: `query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 2) Data sanity — empty data is a warn, not a fail (a brand-new
  // deploy would legitimately have zero rows).
  if (typeof counts.watchedUsers === "number") {
    checks.push({
      name: "data.watchedUsers",
      status: counts.watchedUsers > 0 ? "ok" : "warn",
      detail: `${counts.watchedUsers} watchedUser row(s)`,
    });
  }
  if (typeof counts.playlists === "number") {
    checks.push({
      name: "data.playlists",
      status: counts.playlists > 0 ? "ok" : "warn",
      detail: `${counts.playlists} playlist row(s)`,
    });
  }

  // 3) WatchedUser avatar coverage. Both 179366 and ryanng were
  // backfilled; if either drops back to null something regressed.
  try {
    const missingAvatar = await prisma.watchedUser.count({
      where: { imageUrl: null },
    });
    checks.push({
      name: "data.avatarCoverage",
      status: missingAvatar === 0 ? "ok" : "warn",
      detail: `${missingAvatar} watchedUser(s) with null imageUrl`,
    });
  } catch (e) {
    checks.push({
      name: "data.avatarCoverage",
      status: "fail",
      detail: `query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 4) Cron freshness — last PollLog should be within STALE_CRON_MS.
  try {
    const lastPoll = await prisma.pollLog.findFirst({
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    if (!lastPoll) {
      checks.push({
        name: "cron.freshness",
        status: "warn",
        detail: "no PollLog rows ever",
      });
    } else {
      const ageMs = now - lastPoll.startedAt.getTime();
      const stale = ageMs > STALE_CRON_MS;
      checks.push({
        name: "cron.freshness",
        status: stale ? "warn" : "ok",
        detail: `last poll ${Math.round(ageMs / 60000)}min ago${stale ? " (stale)" : ""}`,
      });
    }
  } catch (e) {
    checks.push({
      name: "cron.freshness",
      status: "fail",
      detail: `query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 5) Cron success rate over the last 24h.
  try {
    const since = new Date(now - 24 * 60 * 60 * 1000);
    const recent = await prisma.pollLog.findMany({
      where: { startedAt: { gte: since } },
      select: { error: true },
    });
    if (recent.length === 0) {
      checks.push({
        name: "cron.successRate24h",
        status: "warn",
        detail: "no polls in last 24h",
      });
    } else {
      const errors = recent.filter((r) => r.error).length;
      const rate = ((recent.length - errors) / recent.length) * 100;
      const status: CheckStatus =
        rate >= 90 ? "ok" : rate >= 50 ? "warn" : "fail";
      checks.push({
        name: "cron.successRate24h",
        status,
        detail: `${recent.length - errors}/${recent.length} succeeded (${rate.toFixed(0)}%)`,
      });
    }
  } catch (e) {
    checks.push({
      name: "cron.successRate24h",
      status: "fail",
      detail: `query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 6) Spotify cooldown — if we're rate-limited right now, surface it.
  try {
    const cooldownRow = await prisma.appState.findUnique({
      where: { key: "spotify:rateLimitedUntil" },
    });
    if (!cooldownRow) {
      checks.push({
        name: "spotify.cooldown",
        status: "ok",
        detail: "no active cooldown",
      });
    } else {
      const until = new Date(cooldownRow.value).getTime();
      const remainingS = Math.max(0, Math.round((until - now) / 1000));
      checks.push({
        name: "spotify.cooldown",
        status: remainingS > 0 ? "warn" : "ok",
        detail: remainingS > 0 ? `${remainingS}s remaining` : "expired",
      });
    }
  } catch (e) {
    checks.push({
      name: "spotify.cooldown",
      status: "fail",
      detail: `query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 7) WatchedUser sync freshness — if a user hasn't synced in
  // STALE_SYNC_MS, surface it.
  try {
    const stale = new Date(now - STALE_SYNC_MS);
    const stuck = await prisma.watchedUser.count({
      where: { OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: stale } }] },
    });
    checks.push({
      name: "watchedUser.syncFreshness",
      status: stuck === 0 ? "ok" : "warn",
      detail: `${stuck} watchedUser(s) not synced in 14d`,
    });
  } catch (e) {
    checks.push({
      name: "watchedUser.syncFreshness",
      status: "fail",
      detail: `query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 8) Orphan playlists. A row with watchedUserId=null and
  // lastCheckedAt=null is "Pending" by design; the dashboard's
  // auto-drain effect plus AutoRefresh should attach it within seconds.
  // A row stuck >STUCK_ORPHAN_MS without being polled means the drain
  // path is broken (or rate-limited far longer than the cooldown
  // suggests). Recently-created orphans are not a fail — they're the
  // expected transient state right after Add.
  try {
    const stuckCutoff = new Date(now - STUCK_ORPHAN_MS);
    const [totalOrphans, stuckOrphans] = await Promise.all([
      prisma.playlist.count({ where: { watchedUserId: null } }),
      prisma.playlist.count({
        where: {
          watchedUserId: null,
          createdAt: { lt: stuckCutoff },
        },
      }),
    ]);
    let status: CheckStatus = "ok";
    let detail = `${totalOrphans} orphan playlist(s)`;
    if (stuckOrphans > 0) {
      status = "warn";
      detail = `${totalOrphans} orphan(s); ${stuckOrphans} stuck >${Math.round(STUCK_ORPHAN_MS / 60000)}min`;
    } else if (totalOrphans > 0) {
      detail = `${totalOrphans} transient orphan(s) (recently added)`;
    }
    checks.push({ name: "playlists.orphanAttach", status, detail });
  } catch (e) {
    checks.push({
      name: "playlists.orphanAttach",
      status: "fail",
      detail: `query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return NextResponse.json({
    status: pickWorst(checks),
    checks,
    counts,
    generatedAt: new Date(now).toISOString(),
  });
}
