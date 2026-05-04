// Shared dashboard data loader. Used by both:
//   - SSR fallback in src/app/page.tsx (instant first paint)
//   - SWR JSON in src/app/api/dashboard/route.ts (background revalidate)
//
// Keeping one source of truth for the shape eliminates the drift between
// page.tsx and /api/dashboard that crept in pre-WatchedUser. Pure DB
// reads — never calls Spotify.

import { Prisma } from "@prisma/client";
import { prisma } from "./db";

// Serialisable subset of Playlist for the client. Strings only — no Date
// objects, no Prisma class instances. Keep this in sync with the
// PlaylistRow consumed by DashboardPlaylistList.
export interface PlaylistRow {
  id: string;
  spotifyId: string;
  name: string;
  imageUrl: string | null;
  ownerSpotifyId: string | null;
  ownerDisplayName: string | null;
  watchedUserId: string | null;
  section: "main" | "new" | "other";
  status: string;
  lastCheckedAt: string | null;
  _count: { tracks: number };
}

export interface WatchedUserRow {
  id: string;
  spotifyId: string;
  displayName: string | null;
  imageUrl: string | null;
  lastSyncedAt: string | null;
  // Counts derived server-side so the client doesn't have to recompute
  // (and so the Main-cap UI shows "X / 12" without scanning playlists).
  mainCount: number;
  newCount: number;
  otherCount: number;
}

export interface TrackRow {
  id: string;
  playlistId: string;
  spotifyTrackId: string;
  title: string;
  artists: string;
  album: string | null;
  albumImageUrl: string | null;
  addedAt: string;
}

export interface DashboardData {
  watchedUsers: WatchedUserRow[];
  playlists: PlaylistRow[];
  recentByPlaylist: Record<string, TrackRow[]>;
  // Adds-this-week count per playlist. Drives the "+N this week" badge,
  // the section auto-collapse (no week activity = collapsed), and the
  // "+ Show N inactive" row filter. Independent of the sort key.
  weekByPlaylist: Record<string, number>;
  // Most recent addedAt timestamp (ISO 8601) per playlist, across all
  // time. Drives the default sort order — playlists with the most
  // recent additions surface first. Missing entry = playlist has no
  // tracks yet (sinks to the bottom of its section).
  latestAddedAtByPlaylist: Record<string, string>;
  errorByPlaylist: Record<string, string>;
  hasPushSub: boolean;
  needsReauth: boolean;
  cooldownSeconds: number;
  user: { displayName: string | null; spotifyId: string };
}

// Returns null if userId doesn't match any user (deleted account but a
// stale signed cookie still floats around). Caller renders unauth.
export async function loadDashboardData(
  userId: string,
): Promise<DashboardData | null> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // User lookup runs IN PARALLEL with the rest of the data fan-out so
  // we don't pay a serial round-trip on the first byte.
  const [user, watchedUsers, playlists] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.watchedUser.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: {
        // Pull section-keyed counts via a raw aggregate. Prisma can't
        // groupBy nested through a relation in one query, so we do an
        // inexpensive server-side grouping below.
        playlists: { select: { section: true } },
      },
    }),
    prisma.playlist.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { tracks: true } } },
    }),
  ]);

  if (!user) return null;

  const playlistIds = playlists.map((p) => p.id);

  const [weekCounts, latestAdded, lastErrors, allRecentTracks, hasPushSub] =
    await Promise.all([
      prisma.track.groupBy({
        by: ["playlistId"],
        _count: { _all: true },
        where: {
          playlistId: { in: playlistIds },
          addedAt: { gte: since },
        },
      }),
      // Unwindowed max(addedAt) per playlist — feeds the latest-additions
      // sort. A separate aggregate from weekCounts because that one is
      // bounded to the last 7 days, and "latest" is an all-time signal.
      prisma.track.groupBy({
        by: ["playlistId"],
        _max: { addedAt: true },
        where: { playlistId: { in: playlistIds } },
      }),
      prisma.pollLog.findMany({
        where: { playlistId: { in: playlistIds } },
        orderBy: { startedAt: "desc" },
        distinct: ["playlistId"],
        select: { playlistId: true, error: true, startedAt: true },
      }),
      playlistIds.length > 0
        ? prisma.$queryRaw<
            {
              id: string;
              playlistId: string;
              spotifyTrackId: string;
              title: string;
              artists: string;
              album: string | null;
              albumImageUrl: string | null;
              addedAt: Date;
            }[]
          >(Prisma.sql`
            SELECT t.*
            FROM "Track" t
            WHERE "playlistId" IN (${Prisma.join(playlistIds)})
              AND "addedAt" >= ${since}
            ORDER BY "addedAt" DESC
          `)
        : Promise.resolve([]),
      prisma.pushSubscription
        .count({ where: { userId } })
        .then((n) => n > 0),
    ]);

  // Serialise playlists.
  const playlistRows: PlaylistRow[] = playlists.map((p) => ({
    id: p.id,
    spotifyId: p.spotifyId,
    name: p.name,
    imageUrl: p.imageUrl,
    ownerSpotifyId: p.ownerSpotifyId,
    ownerDisplayName: p.ownerDisplayName,
    watchedUserId: p.watchedUserId,
    // Cast: section is typed as String in the schema (Prisma doesn't
    // enforce string-literal unions). We trust callers (PATCH endpoint
    // + sync logic) to write only valid values.
    section: (p.section as PlaylistRow["section"]) ?? "main",
    status: p.status,
    lastCheckedAt: p.lastCheckedAt?.toISOString() ?? null,
    _count: { tracks: p._count.tracks },
  }));

  // Serialise watched users with section counts.
  const watchedUserRows: WatchedUserRow[] = watchedUsers.map((wu) => {
    let mainCount = 0;
    let newCount = 0;
    let otherCount = 0;
    for (const p of wu.playlists) {
      if (p.section === "main") mainCount++;
      else if (p.section === "new") newCount++;
      else otherCount++;
    }
    return {
      id: wu.id,
      spotifyId: wu.spotifyId,
      displayName: wu.displayName,
      imageUrl: wu.imageUrl,
      lastSyncedAt: wu.lastSyncedAt?.toISOString() ?? null,
      mainCount,
      newCount,
      otherCount,
    };
  });

  const recentByPlaylist: Record<string, TrackRow[]> = {};
  for (const t of allRecentTracks) {
    const row: TrackRow = {
      id: t.id,
      playlistId: t.playlistId,
      spotifyTrackId: t.spotifyTrackId,
      title: t.title,
      artists: t.artists,
      album: t.album,
      albumImageUrl: t.albumImageUrl,
      addedAt:
        t.addedAt instanceof Date ? t.addedAt.toISOString() : String(t.addedAt),
    };
    if (!recentByPlaylist[t.playlistId]) {
      recentByPlaylist[t.playlistId] = [];
    }
    recentByPlaylist[t.playlistId].push(row);
  }
  for (const bucket of Object.values(recentByPlaylist)) {
    bucket.sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
    );
  }

  const weekByPlaylist: Record<string, number> = {};
  for (const r of weekCounts) weekByPlaylist[r.playlistId] = r._count._all;

  const latestAddedAtByPlaylist: Record<string, string> = {};
  for (const r of latestAdded) {
    if (r._max.addedAt) {
      latestAddedAtByPlaylist[r.playlistId] = r._max.addedAt.toISOString();
    }
  }

  const errorByPlaylist: Record<string, string> = {};
  for (const r of lastErrors) {
    if (r.playlistId && r.error) errorByPlaylist[r.playlistId] = r.error;
  }

  const needsReauth = Object.values(errorByPlaylist).some((e) =>
    e.toLowerCase().includes("token refresh failed"),
  );
  const cooldownSeconds = Object.values(errorByPlaylist)
    .map((e) => {
      const m = e.match(/retry after (\d+)s/i);
      return m ? Number(m[1]) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);

  return {
    watchedUsers: watchedUserRows,
    playlists: playlistRows,
    recentByPlaylist,
    weekByPlaylist,
    latestAddedAtByPlaylist,
    errorByPlaylist,
    hasPushSub,
    needsReauth,
    cooldownSeconds,
    user: {
      displayName: user.displayName,
      spotifyId: user.spotifyId,
    },
  };
}
