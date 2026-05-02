// Shared settings data loader. Used by both:
//   - SSR fallback in src/app/settings/page.tsx (instant first paint)
//   - SWR JSON in src/app/api/settings/route.ts (background revalidate)
//
// Mirrors the dashboard-data and feed-data patterns. Pure DB reads —
// never calls Spotify. Serialises any Date values to ISO strings.

import { prisma } from "./db";

export interface SettingsPlaylistRow {
  id: string;
  name: string;
  imageUrl: string | null;
  notifyEnabled: boolean;
  watchedUserId: string | null;
  section: "main" | "new" | "other";
  sortOrder: number;
  weekCount: number;
}

export interface SettingsWatchedUserRow {
  id: string;
  displayName: string | null;
  spotifyId: string;
  imageUrl: string | null;
}

export interface SettingsData {
  user: {
    displayName: string | null;
    spotifyId: string;
    notifyMain: boolean;
    notifyNew: boolean;
    notifyOther: boolean;
  };
  subCount: number;
  watchedUsers: SettingsWatchedUserRow[];
  playlists: SettingsPlaylistRow[];
}

// Returns null if the userId doesn't match an existing user.
export async function loadSettingsData(
  userId: string,
): Promise<SettingsData | null> {
  // Parallel fan-out, including the user lookup, so cold-start latency
  // is one DB round-trip instead of two serial.
  const [user, playlists, watchedUsers, subCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.playlist.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.watchedUser.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.pushSubscription.count({ where: { userId } }),
  ]);

  if (!user) return null;

  // Adds-this-week counts per playlist — feeds the "weekly" sort mode
  // when the user picked it in the dashboard preference.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const playlistIds = playlists.map((p) => p.id);
  const weekCounts =
    playlistIds.length > 0
      ? await prisma.track.groupBy({
          by: ["playlistId"],
          _count: { _all: true },
          where: {
            playlistId: { in: playlistIds },
            addedAt: { gte: since },
          },
        })
      : [];
  const weekByPlaylist = new Map<string, number>();
  for (const w of weekCounts) weekByPlaylist.set(w.playlistId, w._count._all);

  return {
    user: {
      displayName: user.displayName,
      spotifyId: user.spotifyId,
      notifyMain: user.notifyMain,
      notifyNew: user.notifyNew,
      notifyOther: user.notifyOther,
    },
    subCount,
    watchedUsers: watchedUsers.map((wu) => ({
      id: wu.id,
      displayName: wu.displayName,
      spotifyId: wu.spotifyId,
      imageUrl: wu.imageUrl,
    })),
    playlists: playlists.map((p) => ({
      id: p.id,
      name: p.name,
      imageUrl: p.imageUrl,
      notifyEnabled: p.notifyEnabled,
      watchedUserId: p.watchedUserId,
      section: (p.section as "main" | "new" | "other") ?? "main",
      sortOrder: p.sortOrder,
      weekCount: weekByPlaylist.get(p.id) ?? 0,
    })),
  };
}
