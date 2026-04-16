import Link from "next/link";
import type { Track } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { AddPlaylistForm } from "@/components/AddPlaylistForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { InstallHint } from "@/components/InstallHint";
import {
  DashboardPlaylistList,
  type PlaylistRow,
  type TrackRow,
} from "@/components/DashboardPlaylistList";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <section className="py-16 text-center">
        <h1 className="mb-4 text-2xl font-semibold">Spotify Playlist Watcher</h1>
        <p className="mb-6 text-neutral-400">
          Sign in with Spotify to start watching playlists for new tracks.
        </p>
        <a
          href="/api/auth/login"
          className="inline-block rounded-full bg-spotify px-6 py-3 font-semibold text-black"
        >
          Sign in with Spotify
        </a>
      </section>
    );
  }

  // Single-round-trip dashboard load. The dashboard page is marked
  // force-dynamic and hits the DB on every navigation — fan everything
  // out in one Promise.all so we only pay one round-trip of latency
  // instead of N×latency.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const playlists = await prisma.playlist.findMany({
    where: { userId: user.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      _count: { select: { tracks: true } },
    },
  });
  const playlistIds = playlists.map((p) => p.id);

  // Top-N-per-group via a single round-trip. We use a window function
  // (ROW_NUMBER OVER PARTITION BY playlistId) so each playlist gets
  // exactly RECENT_PER_PLAYLIST rows regardless of how active any
  // other playlist is. A naive `findMany ... take: N * playlistCount`
  // doesn't work because one very active playlist (e.g. Lalala with
  // 119 recent tracks) eats the entire global take quota and starves
  // every other playlist of recent rows on the dashboard. Asked Prisma
  // for windowed top-N, it doesn't have it natively, so we drop to
  // raw SQL — still O(1) round-trips, still grouped in memory below.
  const RECENT_PER_PLAYLIST = 5;
  const [weekCounts, lastErrors, allRecentTracks, hasPushSub] =
    await Promise.all([
      // "+N this week" should reflect tracks the user actually added
      // recently, not tracks we happened to see for the first time
      // (firstSeenAt). Use addedAt so that re-seeding a long-dormant
      // playlist doesn't show every old track as "new this week".
      prisma.track.groupBy({
        by: ["playlistId"],
        _count: { _all: true },
        where: {
          playlistId: { in: playlistIds },
          addedAt: { gte: since },
        },
      }),
      // Most-recent pollLog per playlist (regardless of error). We
      // filter to errors in JS so a clean poll *after* an errored
      // poll clears the dashboard banner — the previous query
      // returned the latest errored row even when newer successful
      // runs existed, so old errors haunted the UI forever.
      prisma.pollLog.findMany({
        where: { playlistId: { in: playlistIds } },
        orderBy: { startedAt: "desc" },
        distinct: ["playlistId"],
        select: { playlistId: true, error: true, startedAt: true },
      }),
      // Top RECENT_PER_PLAYLIST tracks per playlist via window function.
      // Single query, single round-trip, exactly N rows per group.
      playlistIds.length > 0
        ? prisma.$queryRaw<Track[]>(Prisma.sql`
            SELECT * FROM (
              SELECT t.*,
                     ROW_NUMBER() OVER (
                       PARTITION BY "playlistId" ORDER BY "addedAt" DESC
                     ) AS rn
              FROM "Track" t
              WHERE "playlistId" IN (${Prisma.join(playlistIds)})
            ) ranked
            WHERE rn <= ${RECENT_PER_PLAYLIST}
          `)
        : Promise.resolve([] as Track[]),
      prisma.pushSubscription
        .count({ where: { userId: user.id } })
        .then((n) => n > 0),
    ]);

  const weekByPlaylistMap = new Map(
    weekCounts.map((r) => [r.playlistId, r._count._all]),
  );
  const errorByPlaylistMap = new Map(
    lastErrors.filter((r) => r.error).map((r) => [r.playlistId, r.error]),
  );
  // Group the windowed result by playlistId. The window function
  // already capped each group at RECENT_PER_PLAYLIST; we just need
  // to bucket by playlist id and ensure each bucket is sorted.
  const recentByPlaylistMap = new Map<string, Track[]>();
  for (const t of allRecentTracks) {
    const bucket = recentByPlaylistMap.get(t.playlistId);
    if (bucket) bucket.push(t);
    else recentByPlaylistMap.set(t.playlistId, [t]);
  }
  for (const bucket of recentByPlaylistMap.values()) {
    bucket.sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
  }

  // If any recent poll failed on token refresh, Spotify has revoked the
  // stored refresh token and nothing will work until the user re-auths.
  const needsReauth = Array.from(errorByPlaylistMap.values()).some((e) =>
    e?.toLowerCase().includes("token refresh failed"),
  );

  // Highest cooldown across all rate-limited polls.
  const cooldownSeconds = Array.from(errorByPlaylistMap.values())
    .map((e) => {
      const m = e?.match(/retry after (\d+)s/i);
      return m ? Number(m[1]) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);

  // Serialise data for the client component. Dates become ISO strings,
  // Maps become plain objects, Prisma types become simple interfaces.
  const playlistRows: PlaylistRow[] = playlists.map((p) => ({
    id: p.id,
    spotifyId: p.spotifyId,
    name: p.name,
    imageUrl: p.imageUrl,
    ownerSpotifyId: p.ownerSpotifyId,
    ownerDisplayName: p.ownerDisplayName,
    status: p.status,
    lastCheckedAt: p.lastCheckedAt?.toISOString() ?? null,
    _count: { tracks: p._count.tracks },
  }));
  const recentByPlaylist: Record<string, TrackRow[]> = {};
  for (const [pid, tracks] of recentByPlaylistMap) {
    recentByPlaylist[pid] = tracks.map((t) => ({
      id: t.id,
      playlistId: t.playlistId,
      spotifyTrackId: t.spotifyTrackId,
      title: t.title,
      artists: t.artists,
      album: t.album,
      albumImageUrl: t.albumImageUrl,
      addedAt: t.addedAt.toISOString(),
    }));
  }
  const weekByPlaylist: Record<string, number> = {};
  for (const [pid, count] of weekByPlaylistMap) weekByPlaylist[pid] = count;
  const errorByPlaylist: Record<string, string> = {};
  for (const [pid, err] of errorByPlaylistMap)
    if (pid && err) errorByPlaylist[pid] = err;

  return (
    <section className="space-y-6">
      <InstallHint />

      {needsReauth && (
        <div className="rounded-lg border border-red-700 bg-red-950/50 p-4">
          <p className="mb-2 text-sm font-semibold text-red-200">
            Your Spotify session expired
          </p>
          <p className="mb-3 text-xs text-red-300">
            Spotify rejected the stored refresh token. Sign in again to
            continue — this will not delete your watched playlists.
          </p>
          <a
            href="/api/auth/login"
            className="inline-block rounded-full bg-spotify px-4 py-2 text-sm font-semibold text-black"
          >
            Sign in with Spotify again
          </a>
        </div>
      )}

      {cooldownSeconds > 0 && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
          Spotify is rate-limiting us right now. Syncing will resume in
          ~{cooldownSeconds}s. Existing tracks and dates aren&apos;t
          affected.
        </div>
      )}

      {!hasPushSub && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-4">
          <p className="mb-2 text-sm font-semibold text-amber-200">
            Notifications aren&apos;t enabled on this device
          </p>
          <p className="mb-3 text-xs text-amber-300/90">
            The whole point of this app is to ping you when new songs are
            added to a watched playlist. Open Settings to subscribe — on
            iPhone you must add the app to your Home Screen first.
          </p>
          <Link
            href="/settings"
            className="inline-block rounded-full bg-amber-500 px-4 py-2 text-xs font-semibold text-black"
          >
            Enable notifications
          </Link>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Watched playlists</h1>
          <p className="text-sm text-neutral-400">
            Signed in as {user.displayName ?? user.spotifyId}
          </p>
        </div>
        <AutoRefresh />
      </div>

      <AddPlaylistForm />

      <DashboardPlaylistList
        playlists={playlistRows}
        recentByPlaylist={recentByPlaylist}
        weekByPlaylist={weekByPlaylist}
        errorByPlaylist={errorByPlaylist}
      />
    </section>
  );
}
