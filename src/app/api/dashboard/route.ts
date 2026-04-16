// GET /api/dashboard
//
// Returns all data the dashboard client component needs in a single
// round-trip: playlists (with track counts), recent tracks per playlist,
// week counts, and latest poll errors. Designed to be the SWR cache key
// so page transitions are instant (stale-while-revalidate).
//
// No Spotify calls — pure DB reads.

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import type {
  PlaylistRow,
  TrackRow,
} from "@/components/DashboardPlaylistList";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const playlists = await prisma.playlist.findMany({
    where: { userId: user.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { tracks: true } } },
  });
  const playlistIds = playlists.map((p) => p.id);

  const [weekCounts, lastErrors, allRecentTracks, hasPushSub] =
    await Promise.all([
      prisma.track.groupBy({
        by: ["playlistId"],
        _count: { _all: true },
        where: {
          playlistId: { in: playlistIds },
          addedAt: { gte: since },
        },
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
        .count({ where: { userId: user.id } })
        .then((n) => n > 0),
    ]);

  // Serialise for the client.
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
  // Sort each bucket by addedAt desc.
  for (const bucket of Object.values(recentByPlaylist)) {
    bucket.sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
    );
  }

  const weekByPlaylist: Record<string, number> = {};
  for (const r of weekCounts) weekByPlaylist[r.playlistId] = r._count._all;

  const errorByPlaylist: Record<string, string> = {};
  for (const r of lastErrors) {
    if (r.playlistId && r.error) errorByPlaylist[r.playlistId] = r.error;
  }

  // Derived flags.
  const needsReauth = Object.values(errorByPlaylist).some((e) =>
    e.toLowerCase().includes("token refresh failed"),
  );
  const cooldownSeconds = Object.values(errorByPlaylist)
    .map((e) => {
      const m = e.match(/retry after (\d+)s/i);
      return m ? Number(m[1]) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);

  return NextResponse.json({
    playlists: playlistRows,
    recentByPlaylist,
    weekByPlaylist,
    errorByPlaylist,
    hasPushSub,
    needsReauth,
    cooldownSeconds,
    user: {
      displayName: user.displayName,
      spotifyId: user.spotifyId,
    },
  });
}
