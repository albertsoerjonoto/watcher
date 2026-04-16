# Git

- **GitHub noreply email:** `29353764+albertsoerjonoto@users.noreply.github.com`
- **PR base branch:** `main`
- **Repo:** `albertsoerjonoto/watcher`
- **Production URL:** `https://playlistwatcher.vercel.app`
- **Vercel project:** `https://vercel.com/albertsoerjonotos-projects/watcher`

---

# Spotify rate-limit prevention — DO NOT SKIP

Read this before touching anything that calls `fetch()` to a spotify.com
domain. Getting this wrong earned us an 11-hour 429 cooldown in April
2026 and will earn you another one.

## The rules Spotify plays by

- **Rolling 30-second window**, per app (client_id), aggregated across
  all users. Not per-endpoint.
  Source: <https://developer.spotify.com/documentation/web-api/concepts/rate-limits>
- **Development mode = 5 authenticated users max**. The per-request
  quota is lower than extended-quota mode; Spotify publishes no exact
  number.
- **Extended Quota Mode requires 250k+ MAUs** and a registered business
  entity. Not an option for a personal watcher.
  Source: <https://developer.spotify.com/documentation/web-api/concepts/quota-modes>
- **`Retry-After` header is authoritative** and in seconds. We have
  observed real values over 40,000 (~11h). Honor it literally — do not
  retry inside the window.
- **Spotify has no webhooks.** Polling is the only option.
  `snapshot_id` conditional short-circuits are the right optimization.
- **api-partner.spotify.com (Pathfinder) and open.spotify.com/embed are
  gray-area internal endpoints**. They share the same per-IP /
  per-account bucket as api.spotify.com from the rate-limiter's
  perspective. Falling through to them after a 429 on api.spotify.com
  *extends* the penalty rather than routing around it.

## The rules this codebase enforces

All of these are checked in CI via `npm test` and at runtime. If you
find yourself wanting to bypass one, stop and read this file again.

1. **Every outgoing Spotify request MUST pass through
   `assertCanCallSpotify()`** from `src/lib/rate-limit.ts`. The guard
   is a function call, not a lint rule, so review every new `fetch()`
   to `*.spotify.com` carefully.

2. **Cooldown is persisted to `AppState` in Postgres**, not in-memory.
   A cold-started serverless instance cannot re-fire a blocked request
   "because it didn't know" — the guard reads the DB-backed value.

3. **We maintain our own rolling-30s budget** in `rate-limit.ts`
   (`BUDGET_MAX_REQUESTS = 60`). This rejects proactively, before
   Spotify gets a chance to see a request we shouldn't have made. 60
   is well under whatever the real dev-mode ceiling is — do not raise
   it without a very good reason.

4. **On 429, we call `recordRateLimited(retryAfter)` and throw
   immediately.** No retry. No fallback endpoint escalation. The
   single place this happens is `spotifyGet()` in `src/lib/spotify.ts`.

5. **Fallback fetchers (Pathfinder, Client-Credentials, embed) are
   also guarded** at the entry of each helper. If the cooldown is
   active they return `null` / empty tracks — they do NOT try to route
   around the block.

6. **`/api/refresh` is double-gated**:
   - Checks `getCooldownSeconds()` first (DB read, zero Spotify calls).
     If cooling down, returns `{ skipped: "cooldown" }` immediately.
   - Then skips any playlist whose `lastCheckedAt` is newer than
     `STALE_THRESHOLD_MS` (10 minutes). Rapid tab-switching can't
     re-poll fresh data.

7. **The client AutoRefresh widget calls `/api/sync-status` first**,
   which is DB-only. It only fires `/api/refresh` if `cooldownSeconds
   === 0 && staleCount > 0`. Mounting the dashboard never triggers a
   Spotify call if nothing needs refreshing.

8. **`/api/cron/poll` checks the cooldown before enumerating users**.
   A cron tick during a cooldown window is a no-op.

## Things NOT to do

- Don't add a `fetch()` to any Spotify domain without wiring it through
  `assertCanCallSpotify` + `recordSpotifyCall`.
- Don't catch a 429 and retry a different endpoint. Every Spotify
  endpoint shares the same bucket.
- Don't lower `STALE_THRESHOLD_MS` below a few minutes "to make it feel
  faster". Notifications (via web push) are the real latency story,
  not the dashboard auto-refresh cadence.
- Don't raise `BUDGET_MAX_REQUESTS`. If you feel like you need to, you
  have a bug — some loop is fanning out.
- Don't call `/api/refresh` from a React effect that can fire more than
  once per 10 seconds. AutoRefresh has a 10s debounce; anything else
  should too.

## If we get rate-limited anyway

1. **Do not panic-retry.** Every retry into an active window extends it.
2. Read `AppState` for `spotify:rateLimitedUntil` — that's the exact
   recovery time.
3. The dashboard will show the countdown automatically (amber banner
   and header badge). Leave it alone.
4. Use the time to verify the cooldown is actually persisted (check
   the DB) and that nothing in the app is firing Spotify calls (check
   Vercel logs for `spotifyGet` calls during the window).
5. Once the cooldown clears, the next scheduled cron tick (or the
   user opening the dashboard) will pick up where we left off.

## Libraries we deliberately don't use

- `@spotify/web-api-ts-sdk` — has no built-in Retry-After handling.
- `spotify-web-api-node` — same, also unmaintained.
- `bottleneck` — nice, but cross-instance state would need Redis which
  we don't have. The AppState + in-memory bucket combination gives us
  90% of what Bottleneck would, with zero infra.

If you decide to bring one of these in, do it from a branch and verify
it actually respects `Retry-After` end-to-end before merging.
