// Client-side helper that drains the never-polled-yet queue by
// repeatedly calling /api/playlists/poll-pending until `remaining` is 0.
//
// Used in two places:
//   1. WatchedUserGroup sync handler — after a Sync brings in 50+
//      Other-section playlists, drain so they leave "Loading…" before
//      the next cron tick.
//   2. AddPlaylistForm — after the user pastes a single URL, drain so
//      the orphan attaches to its WatchedUser without waiting for cron.
//   3. DashboardPlaylistList mount effect — auto-drain any orphans the
//      previous session left behind (e.g. a /retry that was throttled).
//
// Backoff handles BOTH 429 reasons:
//   - skipped: "cooldown" → Spotify-level rate limit; sleep cooldownSeconds (capped 30s)
//   - skipped: "throttled" → cross-instance batch throttle (60s window);
//     sleep retryAfterSeconds (capped 30s) so we don't spin
//
// The earlier version only handled "cooldown" and burned ~60 short
// loops to wait out a single 60-second throttle window.

const MAX_LOOPS = 60; // ~5 min at 5/loop is plenty for 50-playlist syncs.
const STEP_BACKOFF_MS = 800;
const RATE_LIMIT_PAUSE_MS = 5000;
const MAX_WAIT_SECONDS = 30;

interface PollPendingResponse {
  polled?: number;
  remaining?: number;
  hitRateLimit?: boolean;
  skipped?: "cooldown" | "throttled" | "fresh";
  cooldownSeconds?: number;
  retryAfterSeconds?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function drainPendingPolls(
  onStatus?: (status: string) => void,
): Promise<{ polled: number; remaining: number }> {
  let polledTotal = 0;
  let lastRemaining = 0;
  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const res = await fetch("/api/playlists/poll-pending", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });
    const body = (await res.json().catch(() => ({}))) as PollPendingResponse;

    if (body.skipped === "cooldown") {
      const wait = Math.min(body.cooldownSeconds ?? 5, MAX_WAIT_SECONDS);
      onStatus?.(
        `rate-limited, waiting ${wait}s (${body.remaining ?? "?"} pending)`,
      );
      lastRemaining = body.remaining ?? lastRemaining;
      await sleep(wait * 1000);
      continue;
    }

    // Cross-instance batch throttle. Without this branch the loop would
    // burn its iteration budget waiting 800ms at a time for the 60s
    // window to clear. Honor retryAfterSeconds and continue.
    if (body.skipped === "throttled") {
      const wait = Math.min(body.retryAfterSeconds ?? 5, MAX_WAIT_SECONDS);
      onStatus?.(
        `throttled, waiting ${wait}s (${body.remaining ?? "?"} pending)`,
      );
      lastRemaining = body.remaining ?? lastRemaining;
      await sleep(wait * 1000);
      continue;
    }

    polledTotal += body.polled ?? 0;
    lastRemaining = body.remaining ?? 0;
    if (lastRemaining === 0) {
      onStatus?.(`polled ${polledTotal}`);
      return { polled: polledTotal, remaining: 0 };
    }
    onStatus?.(`polled ${polledTotal}, ${lastRemaining} pending`);
    await sleep(body.hitRateLimit ? RATE_LIMIT_PAUSE_MS : STEP_BACKOFF_MS);
  }
  onStatus?.(`gave up after ${MAX_LOOPS} loops (${lastRemaining} pending)`);
  return { polled: polledTotal, remaining: lastRemaining };
}
