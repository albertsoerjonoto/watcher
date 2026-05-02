# Watcher — Spotify Playlist Monitor

Monitors Spotify playlists and sends web push notifications when new tracks
are added. Filters out self-additions. PWA-first, deployed on Vercel.

## Tech Stack

- **Framework:** Next.js 14 (App Router), TypeScript
- **Database:** PostgreSQL via Prisma ORM (Neon)
- **Auth:** Spotify OAuth 2.0 with PKCE (no client secret required)
- **Notifications:** Web Push (web-push library, VAPID)
- **Styling:** Tailwind CSS (auto light/dark via `prefers-color-scheme`)
- **Testing:** Vitest
- **Deploy:** Vercel with Cron Jobs

## Commands

- `npm run dev` — Start dev server
- `npm run build` — Production build (`prisma generate && next build`). Does NOT run `prisma db push` — see "Schema migrations" below for why.
- `npm run lint` — ESLint
- `npm test` — Vitest (includes rate-limit guardrail)
- `npm run db:push` — Push schema to DB (manual; only when you have DIRECT_URL set locally)
- `npm run db:seed` — Seed playlists from playlists.json
- `npm run poll` — Manual poll (for local testing)

## Key Files

- `src/lib/rate-limit.ts` — Rate limit chokepoint (CRITICAL, do not weaken)
- `src/lib/spotify.ts` — Spotify API client with 4-tier fallback chain
- `src/lib/diff.ts` — Track diffing logic (composite key: spotifyTrackId + addedAt)
- `src/lib/poll.ts` — Per-playlist poll orchestration
- `src/lib/push.ts` — Web Push dispatcher (prunes dead subscriptions)
- `src/lib/session.ts` — HMAC-signed session cookie
- `src/app/api/cron/poll/route.ts` — Cron-triggered polling endpoint
- `src/app/api/refresh/route.ts` — User-triggered refresh (double-gated)
- `src/app/api/sync-status/route.ts` — DB-only status check (no Spotify calls)

## Conventions

- **All Spotify API calls go through `spotifyFetch()`** in rate-limit.ts — NEVER raw fetch()
- **Snapshot ID short-circuits:** only full-fetch if playlist changed
- **Track identity:** `(spotifyTrackId, addedAt)` tuple, not just ID
- **First-seed silence:** suppress notifications on initial playlist add
- **Owner filter:** don't notify user about their own additions
- **Sequential polling:** playlists polled one-at-a-time to keep rate-limit pressure sane
- **Timestamps:** Jakarta timezone (UTC+7) for display via `src/lib/datetime.ts`

# Git

- **GitHub noreply email:** `29353764+albertsoerjonoto@users.noreply.github.com`
- **PR base branch:** `main`
- **Repo:** `albertsoerjonoto/watcher`
- **Production URL:** `https://playlistwatcher.vercel.app`
- **Vercel project:** `https://vercel.com/albertsoerjonotos-projects/watcher`

---

# Agent loop — autonomous develop → deploy → QA → iterate

This repo expects Claude agents to ship features end-to-end without
human intervention between code change and verified-on-prod. When a
user asks for a feature, run the full loop. Don't stop at "I wrote the
code" — stop at "I saw it work on https://playlistwatcher.vercel.app".

## The loop

1. **Branch.** Always start from latest main:
   ```
   git fetch origin main --quiet
   git checkout -b claude/<short-slug> origin/main
   ```
   Never reuse a branch from a previous loop iteration. Worktree note:
   the parent worktree owns `main`, so you cannot `git checkout main`
   from the agent worktree — every change goes on a feature branch.

2. **Implement.** Make the change. Run `npm test` and `npm run build`
   locally. Both must be green before pushing.

3. **Commit.** Use the GitHub noreply email and a Co-Authored-By
   trailer:
   ```
   git -c user.email='29353764+albertsoerjonoto@users.noreply.github.com' \
     commit -m "$(cat <<'EOF'
   feat(area): one-line summary

   Body explaining the why.

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

4. **Push + PR.** `git push -u origin claude/<slug>`, then `gh pr create
   --base main`. Title under 70 chars, body with Summary + Test plan
   sections.

5. **Review.** Run `/review` (or its checklist mentally) before merging.
   Apply auto-fixes inline. Critical findings need a human in the loop;
   informational ones get a follow-up commit.

6. **Wait for the Vercel preview deploy** to go SUCCESS. Poll with:
   ```
   gh pr view <num> --json statusCheckRollup \
     -q '.statusCheckRollup[] | select(.context=="Vercel") | .state'
   ```
   FAILURE means the build broke; pull the deploy URL from the same
   query and inspect logs in Chrome before pushing a fix.

7. **Merge via the API**, NOT `gh pr merge`. The CLI tries to checkout
   main locally and fails because the parent worktree has it:
   ```
   gh api -X PUT "/repos/albertsoerjonoto/watcher/pulls/<num>/merge" \
     -f merge_method=squash
   gh api -X DELETE "/repos/albertsoerjonoto/watcher/git/refs/heads/<branch>"
   ```

8. **Wait for the production deploy** on the new main commit to go
   SUCCESS:
   ```
   gh api "/repos/albertsoerjonoto/watcher/commits/main/status" \
     -q '.statuses[0].state'
   ```

9. **QA on production** — this is the loop's exit condition. Don't
   trust "the build passed" as proof the feature works.

   **Default (cloud/mobile-friendly): headless Playwright.**
   ```
   npm run qa:prod                           # default URL
   npm run qa:prod -- https://<preview>.vercel.app  # any deploy
   ```
   First run only: `npm run qa:prod:install` to fetch the chromium
   binary. The script (`scripts/qa-prod.ts`) drives a real Chromium
   against the URL, asserts dashboard + feed render correctly, and
   checks console + network are clean. It needs `WATCHER_SESSION_COOKIE`
   set to the value of the `spw_session` cookie from a logged-in
   browser (DevTools → Application → Cookies); without it, it falls
   back to a smoke test that only confirms the sign-in page renders.
   Exits 0 on pass, 1 on fail with a diagnostic dump.

   **Optional (desktop richer view): Chrome MCP.**
   When you're at a desktop and want to actually look at screenshots,
   poke the UI by hand, or debug something non-deterministic:
   - `tabs_context_mcp { createIfEmpty: true }` to get a tab
   - `navigate` to `https://playlistwatcher.vercel.app/<route>`
   - `screenshot` after a 3–4s wait for SWR to populate
   - `find` + `left_click` (or `javascript_tool` for DOM assertions)
   - `read_console_messages { onlyErrors: true }` to confirm clean
   - `read_network_requests { urlPattern: "/api/" }` to confirm 200s

   For mobile/cloud sessions, always use `npm run qa:prod` — Chrome
   MCP requires the local Chrome extension and isn't reachable from a
   cloud sandbox.

10. **Iterate.** If QA reveals a bug or the user reports something
    didn't land, go back to step 1 with a new branch. Don't try to fix
    in-place after merge — open a follow-up PR. Each iteration is
    cheap; a bad rushed merge is expensive.

## Things that bite agents

- `gh pr merge` — fails with "main is already used by worktree". Use
  the API call shown above.
- `prisma db push` during build — fails with "Environment variable not
  found: DATABASE_URL". Vercel's build env doesn't expose runtime env
  vars by default. See "Schema migrations" below.
- Local schema mismatch — the dev DB this agent connects to is NOT the
  production DB. Don't be surprised if `prisma db push` against your
  local `DATABASE_URL` shows orphan tables (`events`, `sessions`)
  that aren't in the schema. Don't `--accept-data-loss` blind.
- `package-lock.json` shows up modified after `npm install` — usually
  a single dev-only line flip; revert it before staging unless deps
  actually changed.

---

# Schema migrations — lazy runtime, not build-time

`prisma db push` cannot run during the Vercel build (DATABASE_URL is
runtime-only). Instead, additive migrations are applied lazily at
runtime via a Prisma client extension in `src/lib/db.ts`.

## How it works

```ts
async function applyMigrations() {
  await prismaBase.$executeRawUnsafe(`
    ALTER TABLE "User"
      ADD COLUMN IF NOT EXISTS "..." ...;
  `);
}

export const prisma = prismaBase.$extends({
  query: {
    user: {
      async $allOperations({ args, query }) {
        await ensureMigrations();
        return query(args);
      },
    },
  },
});
```

The first `prisma.user.*` call after a cold start runs the ALTER (no-op
once the column exists, thanks to `IF NOT EXISTS`). Subsequent calls
in the same Lambda skip — the resolved promise is cached on
`globalThis.watcherMigrations`.

## Adding a column

1. Edit `prisma/schema.prisma` — add the field with a `@default(...)`
   so existing rows backfill cleanly.
2. `npm run db:generate` to refresh the Prisma client types.
3. Append the corresponding `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   to `applyMigrations()` in `src/lib/db.ts`. Always idempotent.
4. If the new column is on a model OTHER than `User`, extend the
   `$extends` block to gate that model too — otherwise reads will hit
   the missing column before the migration runs.
5. Ship through the agent loop; the first request after deploy applies
   the migration in <100ms.

## What this approach does NOT support

- Renaming columns (data loss). Add new + backfill + drop old in
  separate deploys instead.
- Dropping columns (data loss). Stop reading the column first, ship,
  then drop manually via `db:push` from a machine with DIRECT_URL.
- Type changes. Same dance as renames.

For destructive changes, do them by hand from a machine that has the
production DATABASE_URL, then update the schema to match.

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
   (`BUDGET_MAX_REQUESTS = 20`). This rejects proactively, before
   Spotify gets a chance to see a request we shouldn't have made. 20
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
