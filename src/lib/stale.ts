// How long a playlist's `lastCheckedAt` can be before AutoRefresh and
// /api/refresh consider it stale enough to re-poll. 10 minutes is well
// under the notification latency people expect for a playlist watcher
// but far enough apart that rapid tab-switching can't hammer Spotify.
//
// This is the single source of truth for "how often do we actually
// need to hit Spotify" — changing it here updates both the server-side
// poll skip logic and the client-side staleness indicator.
export const STALE_THRESHOLD_MS = 10 * 60 * 1000;
