# Watcher — Spotify Playlist Monitor

Monitors Spotify playlists and sends web push notifications when new tracks
are added. Filters out self-additions. PWA-first, deployed on Vercel.

> **Read [`AUTONOMOUS_LOOP.md`](./AUTONOMOUS_LOOP.md) first.** It's the
> standing system prompt for this account: goal-driven execution,
> continuous iteration, real verification, surgical changes. This file
> only adds project-specific commands, file map, and rate-limit
> guardrails on top of that. If anything here contradicts
> AUTONOMOUS_LOOP.md, AUTONOMOUS_LOOP.md wins.

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
- `npm run qa:prod` — HTTP smoke test against the deployed app (works without a browser; use this as the QA gate in cloud/mobile sessions)
- `npm run qa:prod:visual` — headless-Chromium DOM assertions on the authenticated UI; auto-skips when `WATCHER_SESSION_COOKIE` isn't set
- `npm run qa:prod:install` — one-time per environment: fetch the chromium binary used by `qa:prod:visual`
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

# Agent loop — autonomous develop → deploy → QA → iterate → repeat

This repo expects Claude agents to ship features end-to-end without
human intervention between code change and verified-on-prod, and to
**keep iterating after the first pass succeeds** until a stated stop
condition (see [`AUTONOMOUS_LOOP.md` §"Stop conditions"](./AUTONOMOUS_LOOP.md#stop-conditions-state-which-one-fired)) is met.
When a user asks for a feature, run the full loop, then look for the
next improvement and run it again. Don't stop at "I wrote the code" —
stop at "the criterion is verifiably met on prod and there's no further
valuable improvement on the table."

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

9. **QA on production** — the loop's exit condition. Don't trust
   "the build passed" as proof the feature works. Use whichever path
   matches your environment:

   **Local session (Chrome MCP available):**
   - `tabs_context_mcp { createIfEmpty: true }` to get a tab
   - `navigate` to `https://playlistwatcher.vercel.app/<route>`
   - `screenshot` after a 3–4s wait for SWR to populate
   - `find` + `left_click` (or `javascript_tool` for DOM assertions)
     to exercise interactions
   - `read_console_messages { onlyErrors: true }` to confirm clean
   - `read_network_requests { urlPattern: "/api/" }` to confirm 200s

   **Cloud / mobile session (no browser MCP):**
   - `npm run qa:prod` — HTTP smoke test (7 routes, status + key body
     strings). Catches build crashes, lazy-migration failures, schema
     drift, unauth path 500s. No auth, no browser.
   - `npm run qa:prod:visual` — headless Chromium + DOM assertions on
     the authenticated dashboard and feed. Auto-skips with exit 0 when
     `WATCHER_SESSION_COOKIE` isn't set, so it's safe to chain after
     `qa:prod`. When the cookie IS provisioned this catches visual
     regressions (e.g. the date+time format from PR #75) without a
     human visiting the site.
   - For changes that even visual QA can't cover (push notifications,
     OAuth flows, cron-triggered behavior), state in the PR body what
     was deferred. Don't overclaim "verified on prod".

10. **Iterate.** If QA reveals a bug or the user reports something
    didn't land, go back to step 1 with a new branch. Don't try to fix
    in-place after merge — open a follow-up PR. Each iteration is
    cheap; a bad rushed merge is expensive.

11. **Continuous improvement loop.** After QA passes, do NOT declare
    done by default. Scan the post-merge improvement triggers from
    [`AUTONOMOUS_LOOP.md` §"Continuous-improvement triggers"](./AUTONOMOUS_LOOP.md#continuous-improvement-triggers)
    — stale docs, dead code, TODOs, security review, design review,
    perf measurement, observability, test coverage gaps, schema
    drift. Each trigger that fires is either a same-session follow-up
    PR (preferred) or a tracked TODO. Only stop when a stop condition
    from `AUTONOMOUS_LOOP.md` is genuinely met — and state which one.

12. **Race-aware before opening a PR.** Multiple agents may be
    working in parallel. Run:
    ```
    git fetch origin main --quiet
    git log origin/main -5 --oneline
    ```
    If main moved past your branch base, rebase before push. Before
    `gh api -X PUT .../merge`, re-check `gh pr view <num> --json
    mergeable -q .mergeable` — if it says `CONFLICTING`, rebase or
    close as superseded rather than force-fixing in flight.

## Cloud / mobile variant

Claude Code Mobile and other cloud sessions run on a fresh GitHub
clone in a sandbox — no worktree, no Chrome MCP, no local Vercel CLI.
The loop is the same shape with two differences:

- **Step 7 (merge):** `gh pr merge --squash --delete-branch <num>`
  works directly. The "main is held by a worktree" failure only
  happens locally; in a clean sandbox there's no parent worktree to
  conflict with.
- **Step 9 (QA):** chain two scripts, both run AFTER step 8 reports
  the prod deploy is green:
  ```
  npm run qa:prod && npm run qa:prod:visual
  ```
  `qa:prod` is HTTP-only — no browser, no auth needed. It hits a
  curated set of routes and asserts the expected unauth response,
  which is enough to catch the failure modes that have actually
  bitten this app (build crash, lazy-migration broken, Prisma schema
  drift). `qa:prod:visual` adds authenticated DOM assertions via
  headless Chromium when `WATCHER_SESSION_COOKIE` is set; otherwise
  it self-skips with exit 0, so the chain stays green either way.

  First run only on a fresh sandbox: `npm run qa:prod:install` to
  fetch the chromium binary (~92 MB).

  To enable visual QA, paste the `spw_session` cookie from a
  logged-in browser into `WATCHER_SESSION_COOKIE` (env var, repo
  secret, etc.). Cookies are HMAC-signed with a 30-day TTL — refresh
  monthly. See `scripts/qa-prod-visual.ts` header for the exact
  extraction steps.

If a feature falls outside what either script covers (push
notifications, OAuth flows, cron behavior), be honest in the PR
body about what's unverified rather than overclaiming "verified on
prod". The user can confirm out of band.

## Infrastructure access (Vercel, Supabase, GitHub)

The user is already logged in to Vercel, Supabase, and GitHub on their
desktop. You operate within those authenticated sessions — never enter
passwords. The right tool by environment:

- **GitHub:** `gh` CLI is the default for everything (PRs, releases,
  issues, branches, commits). Use it from any environment.
- **Vercel:** the [Vercel project dashboard](https://vercel.com/albertsoerjonotos-projects/watcher)
  via Chrome MCP (local) is fine for inspecting deploys, env vars, and
  logs. The `vercel` CLI works locally if installed. For env-var
  changes use the dashboard via Chrome MCP — read the change back to
  confirm before declaring done.
- **Supabase / Neon (DB):** schema migrations are lazy at runtime via
  `src/lib/db.ts` — see "Schema migrations" below. For destructive ops
  (drop column, drop table, rename) you need DIRECT_URL set locally
  and `npm run db:push`; ask once before doing this and proceed only
  on explicit "yes."

For destructive ops on any of these (delete project, change billing,
drop tables, rotate secrets, public env-var changes), confirm with the
user once and proceed only after explicit "yes." Read state freely.

## Things that bite agents

- `gh pr merge` — fails locally with "main is already used by
  worktree". Use the API call shown in step 7. (Doesn't bite cloud
  sessions — see "Cloud / mobile variant" above.)
- **Parallel-agent merge conflicts.** Two PRs landing the same minute
  is real (PR #82 was superseded by #81 — same problem, same minute,
  different solution). Always race-check per step 12 above.
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
   (`BUDGET_MAX_REQUESTS = 10`). This rejects proactively, before
   Spotify gets a chance to see a request we shouldn't have made. 10
   is well under whatever the real dev-mode ceiling is — do not raise
   it without a very good reason. (Was 20 before May 2026's
   aggregate-vs-individual lockout, see "history" below.)

4. **On 429, we call `recordRateLimited(retryAfter)` and throw
   immediately.** No retry. No fallback endpoint escalation. The
   single place this happens is `spotifyGet()` in `src/lib/spotify.ts`.

5. **Fallback fetchers (Pathfinder, Client-Credentials, embed) are
   also guarded** at the entry of each helper. If the cooldown is
   active they return `null` / empty tracks — they do NOT try to route
   around the block.

6. **`/api/refresh` is triple-gated**:
   - **Gate 1 — cooldown:** `getCooldownSeconds()` (DB read, zero
     Spotify calls). If cooling down, returns
     `{ skipped: "cooldown" }` immediately.
   - **Gate 2 — refresh-batch throttle:** `getRefreshBatchThrottleSeconds()`
     (DB read). If any caller (any tab, any cron tick, any lambda)
     started a Spotify batch within the last 60s, return
     `{ skipped: "throttled" }`. This is the SERVER-enforced
     can't-bypass guard — fresh JS contexts can't sidestep it.
   - **Gate 3 — staleness:** skips any playlist whose `lastCheckedAt`
     is newer than `STALE_THRESHOLD_MS` (10 minutes). Rapid tab-switching
     can't re-poll fresh data.
   - On reaching the Spotify-bound section, calls
     `recordRefreshBatchStarted()` BEFORE the first `spotifyFetch` so
     a concurrent caller sees the new value and bails too.

7. **The client AutoRefresh widget calls `/api/sync-status` first**,
   which is DB-only. It only fires `/api/refresh` if `cooldownSeconds
   === 0 && refreshThrottleSeconds === 0 && staleCount > 0`. Mounting
   the dashboard never triggers a Spotify call if nothing needs
   refreshing — and even if it does, gate 2 kicks in.

8. **`/api/cron/poll` is also batch-throttled**. Cron and the user
   share Spotify's bucket; racing both into the same 30-second window
   is the failure mode we are explicitly trying to avoid. The cron
   tick honors the same `getRefreshBatchThrottleSeconds()` gate as
   `/api/refresh`.

9. **EVERY endpoint that issues a multi-call Spotify batch must call
   the batch throttle.** Currently:
   - `/api/refresh` (Dashboard auto-refresh)
   - `/api/cron/poll` (daily cron)
   - `/api/playlists/[id]/retry` (per-playlist retry button)
   - `/api/playlists/poll-pending` (newly-added playlist seed loop)
   - `/api/watched-users` POST (add a watched user)
   - `/api/watched-users/[id]/sync` (re-sync a watched user)

   A CI guardrail (`src/lib/refresh-batch-throttle.test.ts`) greps
   each route file for both `getRefreshBatchThrottleSeconds(` and
   `recordRefreshBatchStarted(` and fails if either is missing. Adding
   a new batch endpoint? Add it to that array.

10. **The 5-agent invariant**: with N concurrent callers (5 agents,
    5 tabs, 5 lambdas — same thing) hitting any combination of the
    batch endpoints above, the floor on Spotify call rate is bounded
    by `BUDGET_MAX_REQUESTS / REFRESH_BATCH_MIN_INTERVAL_MS`, currently
    10 calls / 60 seconds = 5 calls / 30 seconds globally. Spotify's
    undocumented dev-mode rolling-30s ceiling is somewhere above that;
    the four layers compounded leave plenty of headroom. If a future
    refactor changes any constant, do the math again before merging.

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
  should too. (Note: even if you do, the server-side batch throttle
  will turn it into `{ skipped: "throttled" }`, but there's no reason
  to trip it.)
- **Don't ever call `/api/refresh` from a QA / dev test loop without
  understanding the gates.** Clearing localStorage / SW / cache between
  hard reloads of Dashboard does NOT reset the server-side
  refresh-batch throttle, and that's intentional — it's the gate that
  prevents the May 2026 28-minute lockout from ever happening again.
  If your test wants to verify "refresh works", verify the response
  shape (`ok: true, results: ...` OR `skipped: ...`), not that
  Spotify was actually hit.

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
