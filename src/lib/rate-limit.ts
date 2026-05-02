// Centralized Spotify rate-limit guard.
//
// Every outgoing HTTP call to ANY spotify.com host MUST go through
// `spotifyFetch()`. That is the single chokepoint — no raw `fetch()`
// to api.spotify.com, accounts.spotify.com, open.spotify.com, or
// api-partner.spotify.com is allowed anywhere else in the codebase.
// The probe route that caused the April 2026 lockout fired 20+ raw
// requests in one call and retried on 429; never again.
//
// Four layers of protection (cheapest to most durable):
//
//   1. Per-instance rolling-30s token bucket (in-memory).
//      BUDGET_MAX_REQUESTS per BUDGET_WINDOW_MS. Stops a single
//      lambda from bursting past our self-imposed ceiling.
//
//   2. Cross-instance minimum interval between calls (DB-backed).
//      Every request reads+writes AppState["spotify:lastCallAt"]
//      and refuses to fire if another instance called Spotify less
//      than MIN_INTERVAL_MS ago. This caps global throughput at
//      1 call per MIN_INTERVAL_MS regardless of how many lambdas
//      Vercel spins up.
//
//   3. Cross-instance persisted cooldown (DB-backed).
//      On any 429 we write AppState["spotify:rateLimitedUntil"] and
//      refuse every request until it clears. Fail-closed behavior
//      is the whole point of this module.
//
//   4. Cross-instance refresh throttle (DB-backed).
//      Every batch entry point — /api/refresh, /api/cron/poll — must
//      call `assertCanStartRefreshBatch()` and then
//      `recordRefreshBatchStarted()` before doing any Spotify work.
//      This prevents the failure mode that bit us in May 2026: a fresh
//      browser session with cleared SWR / SW caches re-mounts the
//      Dashboard, AutoRefresh fires, /api/refresh polls every stale
//      playlist; the user reloads again, all gates pass because each
//      individual playlist already-stale check looks fine. Across N
//      reloads in a short window the aggregate Spotify call count
//      blows through the budget on the wire even though no single
//      gate saw it. The batch throttle adds a 60-second floor between
//      batches that is independent of which client triggered them.
//
// The four layers compound: you'd have to defeat all of them for a
// runaway loop to dig a hole. Defeating the bucket requires burst
// from one instance; defeating the interval requires crossing the
// DB write latency; defeating the cooldown requires network access
// without going through spotifyFetch(); defeating the batch throttle
// requires the DB to lie about lastRefreshBatchAt.
//
// History (do not repeat):
//
//   - April 2026 we ate a ~40,000-second cooldown after a debug probe
//     route fired 20+ unguarded requests per call with 3x retry on
//     429. Root cause was "raw fetch() outside the chokepoint". Fixed
//     by deleting the route and funneling everything through
//     spotifyFetch().
//   - Earlier, fallback chains (Pathfinder, Client Credentials, embed)
//     kept firing after an api.spotify.com 429, all hitting the same
//     per-IP / per-account bucket. Fixed by gating each fallback at
//     its entry and never "escalating" on 429.
//   - May 2026 the QA agent took a ~28-minute cooldown by clearing
//     localStorage / SW / cache between hard reloads of the Dashboard.
//     Each reload's AutoRefresh saw a fresh JS context, no client-side
//     debounce, called /api/refresh; the cooldown gate was clear and
//     individual playlists were stale, so the batch fired every time.
//     Fixed by adding the cross-instance batch throttle (layer 4).

import { prisma } from "./db";

const COOLDOWN_KEY = "spotify:rateLimitedUntil";
const LAST_CALL_KEY = "spotify:lastCallAt";
const REFRESH_BATCH_KEY = "spotify:lastRefreshBatchAt";

// Rolling window for the per-instance bucket. Spotify's documented
// rule is "a rolling 30-second window" app-wide — we enforce our own
// ceiling well below whatever the real dev-mode limit is (which is
// undocumented).
const BUDGET_WINDOW_MS = 30_000;

// Per-instance ceiling. 10/30s × N instances is still well under any
// plausible dev-mode real limit. Was 60, then 20; lowered to 10 after
// May 2026 lockout where multiple Lambdas each came within budget but
// the aggregate exceeded Spotify's actual ceiling.
const BUDGET_MAX_REQUESTS = 10;

// Global minimum gap between any two Spotify requests. 500ms means a
// hard ceiling of 2 calls/sec globally, regardless of how many
// serverless instances Vercel spins up. A poll cycle with 6 playlists
// at ~2 calls each = 12 calls = 6 seconds, which is still WELL within
// any reasonable rate budget. We'd rather make cron slightly slower
// than risk another multi-hour block.
const MIN_INTERVAL_MS = 500;

// Minimum gap between consecutive refresh BATCHES, regardless of
// caller. A "batch" is an /api/refresh or /api/cron/poll invocation
// that intends to call Spotify N times. The cooldown + budget gates
// only see individual calls; this gate sees the entry point. 60s
// gives any prior batch time to settle and forces "stop hammering"
// behavior on the SERVER, no matter how many tabs / lambdas / SW
// reloads the client throws at us.
const REFRESH_BATCH_MIN_INTERVAL_MS = 60_000;

// In-memory circular buffer of recent call timestamps (per instance).
const recentCalls: number[] = [];

// In-memory cache of the persisted cooldown so we don't hit AppState
// on every call. The write path invalidates immediately.
let cachedCooldownUntil = 0;
let cachedCooldownAt = 0;
const COOLDOWN_CACHE_MS = 5_000;

export class SpotifyRateLimitError extends Error {
  status = 429 as const;
  secondsRemaining: number;
  reason: "cooldown" | "budget" | "interval";
  constructor(
    secondsRemaining: number,
    reason: "cooldown" | "budget" | "interval",
  ) {
    super(
      `Spotify API error 429: Too many requests — retry after ${secondsRemaining}s`,
    );
    this.secondsRemaining = secondsRemaining;
    this.reason = reason;
  }
}

// -----------------------------------------------------------------
// Cooldown (cross-instance, persisted)
// -----------------------------------------------------------------

async function readPersistedCooldown(): Promise<number> {
  const now = Date.now();
  if (now - cachedCooldownAt < COOLDOWN_CACHE_MS) return cachedCooldownUntil;
  try {
    const row = await prisma.appState.findUnique({
      where: { key: COOLDOWN_KEY },
    });
    cachedCooldownUntil = row ? Number(row.value) || 0 : 0;
  } catch {
    // DB unreachable — fail closed on the durable layer by keeping the
    // last-known value. Better than fail-open which would re-arm the
    // penalty on DB hiccups.
  }
  cachedCooldownAt = now;
  return cachedCooldownUntil;
}

/** Current cooldown remaining in seconds, or 0 if clear. */
export async function getCooldownSeconds(): Promise<number> {
  const until = await readPersistedCooldown();
  const ms = until - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/**
 * Persist a server-issued 429. All instances honor the same cooldown
 * through AppState. Idempotent — writing the same value twice is fine,
 * writing a later (greater) value extends the cooldown appropriately.
 */
export async function recordRateLimited(
  retryAfterSeconds: number,
): Promise<void> {
  const s =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.ceil(retryAfterSeconds)
      : 1;
  const until = Date.now() + s * 1000;
  cachedCooldownUntil = until;
  cachedCooldownAt = Date.now();
  try {
    await prisma.appState.upsert({
      where: { key: COOLDOWN_KEY },
      create: { key: COOLDOWN_KEY, value: String(until) },
      update: { value: String(until) },
    });
  } catch {
    // In-memory cache still protects this instance.
  }
}

// -----------------------------------------------------------------
// Cross-instance minimum interval (DB-backed)
// -----------------------------------------------------------------

async function readLastCallAt(): Promise<number> {
  try {
    const row = await prisma.appState.findUnique({
      where: { key: LAST_CALL_KEY },
    });
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

async function writeLastCallAt(ts: number): Promise<void> {
  try {
    await prisma.appState.upsert({
      where: { key: LAST_CALL_KEY },
      create: { key: LAST_CALL_KEY, value: String(ts) },
      update: { value: String(ts) },
    });
  } catch {
    // Non-fatal — the per-instance bucket still guards this process.
  }
}

// -----------------------------------------------------------------
// The gate
// -----------------------------------------------------------------

/**
 * Called at the top of every spotifyFetch. Throws SpotifyRateLimitError
 * if any of the three layers rejects. Never catches — callers must
 * either let it propagate or convert it to a user-facing error.
 */
export async function assertCanCallSpotify(): Promise<void> {
  // Layer 3: persisted cooldown (cheapest to check via cache).
  const cooldown = await getCooldownSeconds();
  if (cooldown > 0) throw new SpotifyRateLimitError(cooldown, "cooldown");

  // Layer 1: per-instance rolling-30s bucket.
  const now = Date.now();
  while (recentCalls.length && now - recentCalls[0] > BUDGET_WINDOW_MS) {
    recentCalls.shift();
  }
  if (recentCalls.length >= BUDGET_MAX_REQUESTS) {
    const wait = Math.ceil(
      (BUDGET_WINDOW_MS - (now - recentCalls[0])) / 1000,
    );
    throw new SpotifyRateLimitError(Math.max(wait, 1), "budget");
  }

  // Layer 2: cross-instance minimum interval. One DB read per call —
  // adds ~50ms via the DB pooler, acceptable given we fire
  // maybe a dozen Spotify calls per cron tick.
  const last = await readLastCallAt();
  const sinceLast = now - last;
  if (last > 0 && sinceLast < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - sinceLast) / 1000) || 1;
    throw new SpotifyRateLimitError(wait, "interval");
  }
}

/**
 * Record a call against the rolling bucket AND stamp the cross-instance
 * lastCallAt. Call this IMMEDIATELY before firing the network request,
 * not after — recording after a successful response creates a race
 * where two concurrent callers both pass assertCanCallSpotify(), both
 * fire requests, and only the second one logs.
 */
export async function recordSpotifyCall(): Promise<void> {
  const now = Date.now();
  recentCalls.push(now);
  await writeLastCallAt(now);
}

// -----------------------------------------------------------------
// THE chokepoint. Every spotify.com fetch in the codebase goes here.
// -----------------------------------------------------------------

/**
 * Allowed Spotify hosts. Anything else passed to spotifyFetch is a bug.
 * Every fetch to one of these hosts — auth tokens, API, Pathfinder,
 * embed, spclient — shares Spotify's rate-limit bucket from their
 * perspective, so all of them must be gated.
 */
const SPOTIFY_HOSTS = new Set([
  "api.spotify.com",
  "accounts.spotify.com",
  "api-partner.spotify.com",
  "open.spotify.com",
  // spclient.wg.spotify.com hosts the Spotify desktop / web app's
  // service-client endpoints, including /user-profile-view/v3/profile
  // which returns a user's profile + public_playlists as JSON when
  // Accept: application/json is set. The web player uses this instead
  // of api.spotify.com for many reads, and it can succeed for users
  // whose api.spotify.com /users/{id}/playlists 403s on third-party
  // privacy settings. Same per-account rate-limit bucket applies, so
  // it MUST go through spotifyFetch.
  "spclient.wg.spotify.com",
]);

function isSpotifyUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return SPOTIFY_HOSTS.has(u.host);
  } catch {
    return false;
  }
}

export interface SpotifyFetchResult {
  status: number;
  ok: boolean;
  headers: Headers;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
}

/**
 * The ONLY function in the codebase permitted to call a Spotify host.
 *
 * Responsibilities:
 *   - Reject at the gate if we're cooling down, over-budget, or
 *     under the global min-interval.
 *   - Record the call before the wire fires (so concurrent callers
 *     can see it via lastCallAt).
 *   - On a 429 response, persist the cooldown and throw. Do NOT retry.
 *     Do NOT fall through to a different Spotify host — they all share
 *     the same bucket and escalating extends the penalty.
 *   - On network errors, throw — still count against the budget so a
 *     hammering loop is self-limiting.
 */
export async function spotifyFetch(
  url: string,
  init?: RequestInit,
): Promise<SpotifyFetchResult> {
  if (!isSpotifyUrl(url)) {
    throw new Error(
      `spotifyFetch called with non-Spotify host: ${url}. If you need ` +
        `to fetch a non-Spotify URL, use the global fetch() directly.`,
    );
  }

  // Gate check with automatic interval wait. Budget and cooldown
  // rejections are hard failures. The min-interval pacing is a
  // throughput concern — aborting a pagination chain because two
  // sequential requests land <500ms apart would be silly, so we
  // sleep through it transparently.
  for (let gateAttempt = 0; ; gateAttempt++) {
    try {
      await assertCanCallSpotify();
      break;
    } catch (e) {
      if (
        e instanceof SpotifyRateLimitError &&
        e.reason === "interval" &&
        gateAttempt < 3
      ) {
        await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
        continue;
      }
      throw e;
    }
  }
  await recordSpotifyCall();

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Network error / DNS / timeout. Budget still ticks against us —
    // the call "happened" from the rate limiter's perspective because
    // we may or may not have actually reached Spotify.
    throw err;
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "1");
    await recordRateLimited(retryAfter);
    // Drain the body so the socket can be reused.
    await res.text().catch(() => "");
    throw new SpotifyRateLimitError(
      Math.max(1, Math.ceil(retryAfter)),
      "cooldown",
    );
  }

  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    text: () => res.text(),
    json: <T,>() => res.json() as Promise<T>,
  };
}

// -----------------------------------------------------------------
// Refresh batch throttle (layer 4, cross-instance, persisted)
// -----------------------------------------------------------------

/**
 * Seconds remaining until the next refresh batch is allowed, or 0 if
 * a batch may start immediately. Cheap DB read; safe to call from any
 * client-facing endpoint that wants to expose the throttle (e.g.
 * /api/sync-status). Does NOT itself reserve a batch slot — call
 * `assertCanStartRefreshBatch()` + `recordRefreshBatchStarted()` for
 * that.
 */
export async function getRefreshBatchThrottleSeconds(): Promise<number> {
  const last = await readRefreshBatchAt();
  if (last <= 0) return 0;
  const ms = REFRESH_BATCH_MIN_INTERVAL_MS - (Date.now() - last);
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/**
 * Throws SpotifyRateLimitError if a refresh batch was started less
 * than REFRESH_BATCH_MIN_INTERVAL_MS ago. Call from /api/refresh and
 * /api/cron/poll — this is the layer-4 "no thundering herd" gate.
 */
export async function assertCanStartRefreshBatch(): Promise<void> {
  const remaining = await getRefreshBatchThrottleSeconds();
  if (remaining > 0) {
    throw new SpotifyRateLimitError(remaining, "interval");
  }
}

/**
 * Stamp lastRefreshBatchAt = now. Call this AFTER the cooldown gate
 * passes and BEFORE the first Spotify call so a concurrent caller
 * sees the new value and bails. Idempotent at the row level.
 */
export async function recordRefreshBatchStarted(): Promise<void> {
  const now = Date.now();
  try {
    await prisma.appState.upsert({
      where: { key: REFRESH_BATCH_KEY },
      create: { key: REFRESH_BATCH_KEY, value: String(now) },
      update: { value: String(now) },
    });
  } catch {
    // Non-fatal — the per-instance bucket and cooldown still bound
    // damage if the DB is briefly unreachable.
  }
}

async function readRefreshBatchAt(): Promise<number> {
  try {
    const row = await prisma.appState.findUnique({
      where: { key: REFRESH_BATCH_KEY },
    });
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

/** For tests: clear in-memory state. Does NOT touch the DB. */
export function __resetRateLimitForTests(): void {
  recentCalls.length = 0;
  cachedCooldownUntil = 0;
  cachedCooldownAt = 0;
}
