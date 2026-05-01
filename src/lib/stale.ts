// How long a playlist's `lastCheckedAt` can be before AutoRefresh and
// /api/refresh consider it stale enough to re-poll. 10 minutes is well
// under the notification latency people expect for a watcher
// but far enough apart that rapid tab-switching can't hammer Spotify.
//
// This is the single source of truth for "how often do we actually
// need to hit Spotify" — changing it here updates both the server-side
// poll skip logic and the client-side staleness indicator.
//
// Applies to playlists in section "main" and "new".
export const STALE_THRESHOLD_MS = 10 * 60 * 1000;

// Staleness threshold for playlists in section "other". These are passive
// listings — the watched user's back catalogue we don't actively notify on.
// 12h means cron polls each Other playlist roughly twice per day with a
// daily cron tick (the per-run cap drains the queue across days). User
// chose "every few hours or worst once a day" — 12h fits within that.
export const OTHER_STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

// Hard cap on Main-section playlists per watched user. Bottleneck here is
// notification noise on the user's lock screen, not Spotify rate budget
// (which is well clear at this size). 12 = 2× the original 6 with comfort.
// The PATCH /api/playlists/:id/section endpoint enforces this; the UI
// surfaces a 409 when promotion would exceed.
export const MAX_MAIN_PER_WATCHED_USER = 12;
