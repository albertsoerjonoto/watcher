// Centralized Spotify rate-limit guard.
//
// Every Spotify HTTP call MUST pass through `assertCanCallSpotify()` at
// entry and call `recordSpotifyCall()` on the way out (success OR 429).
// That's the only place we track the rolling-30s budget and the only
// place we consult the persisted cooldown. The rule: if either gate
// fails, we raise a SpotifyError(429) WITHOUT making a network call,
// so a runaway loop can never dig the hole deeper.
//
// Why this file exists (post-mortem):
//
//   April 2026 we got stuck in a ~12-hour 429 cooldown after rapid
//   iteration on polling logic. Root cause analysis pointed at three
//   compounding problems:
//
//     1. Cooldown was in-memory only. A fresh serverless instance
//        re-fired requests immediately after the previous instance got
//        429'd, re-arming the rolling window.
//     2. Fallback chain (Pathfinder, Client Credentials, embed) kept
//        firing after a 429, all hitting the same Spotify IP bucket
//        and extending the penalty.
//     3. No proactive budget: we only found out we were over the limit
//        when Spotify told us.
//
// This module closes all three: cooldown persists in AppState, the
// token-bucket rejects proactively, and callers get a clear "we are
// cooling down, do not escalate to fallbacks" signal via SpotifyError.

import { prisma } from "./db";

const COOLDOWN_KEY = "spotify:rateLimitedUntil";

// Spotify's documented rule: "a rolling 30-second window." Dev-mode
// apps are capped lower than extended-quota apps (exact number is not
// public). A conservative budget well under whatever the real ceiling
// is: 60 requests per 30s. In practice a single pollPlaylist() call
// costs ~2 requests (meta + tracks page), so this caps us at ~30
// playlist polls per 30s which is far more than we'll ever need.
const BUDGET_WINDOW_MS = 30_000;
const BUDGET_MAX_REQUESTS = 60;

// Circular buffer of recent request timestamps. We keep only what
// matters — anything older than BUDGET_WINDOW_MS is dropped on read.
const recentCalls: number[] = [];

// In-memory cache of the persisted cooldown. We hit AppState at most
// once per 5s per instance to avoid a DB round-trip on every Spotify
// call; the write path (recordRateLimited) invalidates immediately.
let cachedCooldownUntil = 0;
let cachedCooldownAt = 0;
const COOLDOWN_CACHE_MS = 5_000;

export class SpotifyRateLimitError extends Error {
  status = 429 as const;
  secondsRemaining: number;
  reason: "cooldown" | "budget";
  constructor(secondsRemaining: number, reason: "cooldown" | "budget") {
    super(
      `Spotify API error 429: Too many requests — retry after ${secondsRemaining}s`,
    );
    this.secondsRemaining = secondsRemaining;
    this.reason = reason;
  }
}

async function readPersistedCooldown(): Promise<number> {
  const now = Date.now();
  if (now - cachedCooldownAt < COOLDOWN_CACHE_MS) return cachedCooldownUntil;
  try {
    const row = await prisma.appState.findUnique({ where: { key: COOLDOWN_KEY } });
    cachedCooldownUntil = row ? Number(row.value) || 0 : 0;
  } catch {
    // DB unreachable — fail open on this one check rather than
    // bricking the whole request path. The in-memory fallback below
    // still protects us from a runaway in the same instance.
    cachedCooldownUntil = cachedCooldownUntil || 0;
  }
  cachedCooldownAt = now;
  return cachedCooldownUntil;
}

/**
 * Current cooldown remaining in seconds, or 0 if we're clear to call.
 * This is the cheap DB-only check that /api/sync-status and the
 * dashboard banner should use — it makes zero Spotify calls.
 */
export async function getCooldownSeconds(): Promise<number> {
  const until = await readPersistedCooldown();
  const ms = until - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/**
 * Gate called at the top of every Spotify HTTP request. Throws if we
 * are inside a persisted cooldown window OR if the rolling-30s budget
 * has been exhausted. Callers should let the error propagate — do NOT
 * catch it and retry a different endpoint, because every fallback
 * endpoint (api.spotify.com, api-partner.spotify.com, open.spotify.com)
 * shares the same per-IP / per-account bucket.
 */
export async function assertCanCallSpotify(): Promise<void> {
  const cooldown = await getCooldownSeconds();
  if (cooldown > 0) throw new SpotifyRateLimitError(cooldown, "cooldown");

  const now = Date.now();
  while (recentCalls.length && now - recentCalls[0] > BUDGET_WINDOW_MS) {
    recentCalls.shift();
  }
  if (recentCalls.length >= BUDGET_MAX_REQUESTS) {
    // Our self-imposed budget — bail before Spotify has a chance to
    // see the request. Tell the caller how long until the oldest
    // entry ages out of the window.
    const wait = Math.ceil((BUDGET_WINDOW_MS - (now - recentCalls[0])) / 1000);
    throw new SpotifyRateLimitError(Math.max(wait, 1), "budget");
  }
}

/**
 * Record a successful Spotify call against the rolling budget.
 * `assertCanCallSpotify` pops entries off; this pushes them on.
 */
export function recordSpotifyCall(): void {
  recentCalls.push(Date.now());
}

/**
 * Persist a server-issued 429 to AppState so every instance honors
 * the same cooldown. Call this from the single place that receives a
 * 429 response — anywhere else and the prevention layer is useless.
 */
export async function recordRateLimited(retryAfterSeconds: number): Promise<void> {
  const s = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
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
    // Swallow — in-memory cache still protects this instance. A
    // subsequent successful DB write on another call will converge.
  }
}

/** For tests: clear in-memory state. Does NOT touch the DB. */
export function __resetRateLimitForTests(): void {
  recentCalls.length = 0;
  cachedCooldownUntil = 0;
  cachedCooldownAt = 0;
}
