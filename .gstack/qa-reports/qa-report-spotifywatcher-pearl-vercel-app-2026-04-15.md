# QA Report — spotifywatcher-pearl.vercel.app

**Date:** 2026-04-15
**Branch:** claude/spotify-playlist-watcher-MjytH
**Mode:** Diff-aware + full re-test of 6 user-reported issues
**Tier:** Standard
**Auth:** Existing session (Albert)

## Summary

| Severity | Found | Fixed | Deferred |
|----------|------:|------:|---------:|
| Critical | 0     | —     | 0        |
| High     | 0     | —     | 0        |
| Medium   | 0     | —     | 0        |
| Low      | 0     | —     | 0        |

**Health score: 100/100**

PR Summary: QA found 0 new issues this pass; all 6 originally reported issues verified fixed on production.

## Pages tested

| Page | Result | Console errors |
|------|--------|----------------|
| `/` (dashboard) | ✅ | 0 |
| `/feed` | ✅ | 0 |
| `/playlists/[id]` (Afraid To Feel) | ✅ | 0 |
| `/settings` | ✅ | 0 |

## Original 6 user issues — verification

1. **Playlist detail 500 (digest 831514322)** ✅ — `/playlists/cmnyri8gg…` renders h1 "Afraid To Feel", 8 li, 9 imgs (1 cover + 8 album art), oldest-first sort.
2. **Track order wrong + need toggle** ✅ — Default `order=asc` (oldest first), "Switch to Newest first" link present at top of detail page.
3. **Slow nav + confusing re-auth link** ✅ — AutoRefresh debounce reduced 20s → 5s, sync state visible ("syncing…" / "+N new" / "up to date" / "sync error"), confusing re-auth link removed (banner only on real token-refresh failure).
4. **Dashboard UI overhaul** ✅
   - Album art on playlist rows (12 imgs total, 12/12 loaded with naturalWidth>0)
   - "BY ALBERT" group header by owner
   - ↑↓✕ reorder/delete buttons per playlist
   - "+N this week" now uses `addedAt` not `firstSeenAt` — Road to Mars no longer shows ghost "+64 this week"
5. **Jakarta time everywhere** ✅ — Dashboard "15 Apr 2026, 01:27", Feed group header "15 Apr 2026", playlist detail dates "15 Apr 2026". Single source via `src/lib/datetime.ts` (Intl.DateTimeFormat + `timeZone: "Asia/Jakarta"`).
6. **Notifications + auto-update** ✅ — Auto-update verified: AutoRefresh polls /api/refresh on mount, snapshot-id diff detects new tracks (`Relax My Eyes` was caught automatically). Push pipeline verified server-side: VAPID configured, /api/push/subscribe upserts, sw.js handles push event, sendPushToUser fans out + prunes 410s, banner directs unsubscribed users to Settings → "Enable on this device" → "Send test". iOS PWA push end-to-end requires user-side device action.

## Regressions caught and fixed during this QA loop

| Issue | Commit | Fix |
|-------|--------|-----|
| Album art backfill skipped by snapshot short-circuit | 16c2cf9 | Gated short-circuit on missing-images count |
| Sequential updateMany × 64 → HTTP 504 | 83bf4d2 | Promise.all parallelize (then superseded) |
| Promise.all saturated connection_limit=1 pool | 859cc4e | Single raw `UPDATE … FROM (VALUES …)` |
| Backfill re-fired forever for tracks with no Spotify image | ab852ed | Added `Playlist.imageBackfillAt` one-shot marker |
| Stale errored pollLog haunted dashboard banner | 7dd99db | Latest poll regardless of error, JS-side filter |

## Tests

`npx vitest run` → 25/25 passing.
`npx tsc --noEmit` → clean.

## Console health

Zero JS errors observed across dashboard, feed, playlist detail, and settings.
