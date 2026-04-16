"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PlaylistActions } from "./PlaylistActions";
import { RetryButton } from "./RetryButton";
import { formatDateJakarta, formatDateTimeJakarta } from "@/lib/datetime";

// Serialisable subset of the Prisma Playlist model. The server component
// sends this as JSON props — no Date objects, no Prisma class instances.
export interface PlaylistRow {
  id: string;
  spotifyId: string;
  name: string;
  imageUrl: string | null;
  ownerSpotifyId: string | null;
  ownerDisplayName: string | null;
  status: string;
  lastCheckedAt: string | null; // ISO string
  _count: { tracks: number };
}

export interface TrackRow {
  id: string;
  playlistId: string;
  spotifyTrackId: string;
  title: string;
  artists: string; // JSON array
  album: string | null;
  albumImageUrl: string | null;
  addedAt: string; // ISO string
}

interface Props {
  playlists: PlaylistRow[];
  recentByPlaylist: Record<string, TrackRow[]>;
  weekByPlaylist: Record<string, number>;
  errorByPlaylist: Record<string, string>;
}

export function DashboardPlaylistList({
  playlists: initialPlaylists,
  recentByPlaylist,
  weekByPlaylist,
  errorByPlaylist,
}: Props) {
  const [playlists, setPlaylists] = useState(initialPlaylists);
  // Mirror of playlists state for reading inside async queue callbacks
  // without abusing setPlaylists as a read-only side channel.
  const playlistsRef = useRef(initialPlaylists);
  // Serial queue ref to prevent concurrent reorder API calls from racing.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  // Sync local state when SWR revalidates with new data from the server.
  // useState only uses initialPlaylists on mount; this effect keeps the
  // list current after AutoRefresh/mutate triggers a background refetch.
  // We compare playlist IDs to avoid overwriting in-flight optimistic
  // reorders with stale server data — if only the order changed, the
  // optimistic state is likely more current than the server response.
  const prevIdsRef = useRef(initialPlaylists.map((p) => p.id).join(","));
  useEffect(() => {
    const newIds = initialPlaylists.map((p) => p.id).join(",");
    const currentIds = playlistsRef.current.map((p) => p.id).join(",");
    // Sync if playlists were added/removed (ID set changed) or if
    // the data has changed and no optimistic reorder is in flight
    // (the current ID set matches the old server IDs).
    if (newIds !== prevIdsRef.current || currentIds === prevIdsRef.current) {
      setPlaylists(initialPlaylists);
      playlistsRef.current = initialPlaylists;
    }
    prevIdsRef.current = newIds;
  }, [initialPlaylists]);

  // Group playlists by owner. Maintains sortOrder from state.
  const groups = new Map<
    string,
    { ownerName: string; rows: PlaylistRow[] }
  >();
  for (const p of playlists) {
    const key = p.ownerSpotifyId ?? "unknown";
    const ownerName =
      p.ownerDisplayName ?? p.ownerSpotifyId ?? "Unknown owner";
    if (!groups.has(key)) groups.set(key, { ownerName, rows: [] });
    groups.get(key)!.rows.push(p);
  }

  const movePlaylist = useCallback(
    (playlistId: string, direction: "up" | "down") => {
      // Find the playlist in its owner group and swap with neighbor.
      setPlaylists((prev) => {
        const playlist = prev.find((p) => p.id === playlistId);
        if (!playlist) return prev;
        const ownerKey = playlist.ownerSpotifyId ?? "unknown";

        // Build group indices (positions in the flat array that belong
        // to the same owner, preserving flat-array order).
        const groupIndices = prev
          .map((p, i) => ({ p, i }))
          .filter(
            ({ p }) => (p.ownerSpotifyId ?? "unknown") === ownerKey,
          )
          .map(({ i }) => i);

        const posInGroup = groupIndices.findIndex(
          (i) => prev[i].id === playlistId,
        );
        if (posInGroup < 0) return prev;
        const neighborPosInGroup =
          direction === "up" ? posInGroup - 1 : posInGroup + 1;
        if (neighborPosInGroup < 0 || neighborPosInGroup >= groupIndices.length)
          return prev;

        const aIdx = groupIndices[posInGroup];
        const bIdx = groupIndices[neighborPosInGroup];
        const next = [...prev];
        [next[aIdx], next[bIdx]] = [next[bIdx], next[aIdx]];
        playlistsRef.current = next;
        return next;
      });

      // Enqueue API call — serial to prevent races.
      queueRef.current = queueRef.current.then(async () => {
        // Read the current playlist order from the ref to find
        // which playlist was the swap neighbor.
        const current = playlistsRef.current;
        const playlist = current.find((p) => p.id === playlistId);
        let otherId: string | undefined;
        if (playlist) {
          const ownerKey = playlist.ownerSpotifyId ?? "unknown";
          const groupIndices = current
            .map((p, i) => ({ p, i }))
            .filter(
              ({ p }) => (p.ownerSpotifyId ?? "unknown") === ownerKey,
            )
            .map(({ i }) => i);
          const posInGroup = groupIndices.findIndex(
            (i) => current[i].id === playlistId,
          );
          // After the optimistic swap, the "neighbor" that was swapped
          // is now in the direction we came FROM.
          const neighborIdx =
            direction === "up" ? posInGroup + 1 : posInGroup - 1;
          if (neighborIdx >= 0 && neighborIdx < groupIndices.length) {
            otherId = current[groupIndices[neighborIdx]].id;
          }
        }

        if (!otherId) return;
        try {
          const res = await fetch("/api/playlists/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ a: playlistId, b: otherId }),
          });
          if (!res.ok) throw new Error(`reorder ${res.status}`);
        } catch {
          // Revert: swap back
          setPlaylists((prev) => {
            const aIdx = prev.findIndex((p) => p.id === playlistId);
            const bIdx = prev.findIndex((p) => p.id === otherId);
            if (aIdx < 0 || bIdx < 0) return prev;
            const next = [...prev];
            [next[aIdx], next[bIdx]] = [next[bIdx], next[aIdx]];
            playlistsRef.current = next;
            return next;
          });
        }
      });
    },
    [],
  );

  const deletePlaylist = useCallback((playlistId: string) => {
    // Optimistic remove
    setPlaylists((prev) => {
      const next = prev.filter((p) => p.id !== playlistId);
      playlistsRef.current = next;
      return next;
    });

    queueRef.current = queueRef.current.then(async () => {
      try {
        const res = await fetch(`/api/playlists/${playlistId}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`delete ${res.status}`);
      } catch {
        // Can't easily revert a delete (we lost the row data).
        // A page refresh will restore from DB.
      }
    });
  }, []);

  if (playlists.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-800 p-4 text-sm text-neutral-400">
        No playlists yet. Paste a Spotify playlist URL above.
      </div>
    );
  }

  return (
    <>
      {Array.from(groups.entries()).map(([groupKey, { ownerName, rows }]) => (
        <div key={groupKey} className="space-y-2">
          <h2 className="px-1 text-xs uppercase tracking-wide text-neutral-500">
            By {ownerName}
          </h2>
          <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {rows.map((p, groupIdx) => {
              const recent = recentByPlaylist[p.id] ?? [];
              const weekCount = weekByPlaylist[p.id] ?? 0;
              const error = errorByPlaylist[p.id];
              const isRateLimited = error?.includes("429");

              return (
                <li key={p.id} className="p-4">
                  <div className="flex items-start gap-3">
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imageUrl}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="h-14 w-14 shrink-0 rounded bg-neutral-800" />
                    )}
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/playlists/${p.id}`}
                        className="block truncate font-medium hover:underline"
                      >
                        {p.name === p.spotifyId ? (
                          <span className="text-neutral-500">Loading...</span>
                        ) : (
                          p.name
                        )}
                      </Link>
                      <div className="text-xs text-neutral-400">
                        {p._count.tracks} tracks · last checked{" "}
                        {formatDateTimeJakarta(p.lastCheckedAt)}
                        {p.status !== "active" && (
                          <span className="ml-2 text-amber-400">
                            ({p.status})
                          </span>
                        )}
                      </div>
                      {error && (
                        <div
                          className={
                            isRateLimited
                              ? "mt-1 break-all rounded bg-amber-950/60 px-2 py-1 font-mono text-[10px] text-amber-300"
                              : "mt-1 break-all rounded bg-red-950/60 px-2 py-1 font-mono text-[10px] text-red-300"
                          }
                        >
                          {error}
                        </div>
                      )}
                    </div>
                    {weekCount > 0 && (
                      <span className="shrink-0 rounded-full bg-spotify/20 px-2 py-1 text-xs text-spotify">
                        +{weekCount} this week
                      </span>
                    )}
                    <RetryButton playlistId={p.id} />
                    <PlaylistActions
                      playlistName={p.name}
                      isFirst={groupIdx === 0}
                      isLast={groupIdx === rows.length - 1}
                      onMove={(direction) => movePlaylist(p.id, direction)}
                      onDelete={() => deletePlaylist(p.id)}
                    />
                  </div>
                  {recent.length > 0 && (
                    <ul className="mt-3 space-y-1 border-l border-neutral-800 pl-3 text-xs">
                      {recent.map((t) => {
                        const artists = JSON.parse(t.artists) as string[];
                        return (
                          <li
                            key={t.id}
                            className="flex items-center gap-2"
                          >
                            {t.albumImageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={t.albumImageUrl}
                                alt=""
                                className="h-6 w-6 shrink-0 rounded-sm object-cover"
                              />
                            ) : null}
                            <span className="flex-1 truncate">
                              <span className="text-neutral-200">
                                {t.title}
                              </span>
                              <span className="text-neutral-500">
                                {" — "}
                                {artists.join(", ")}
                              </span>
                            </span>
                            <time className="shrink-0 text-neutral-600">
                              {formatDateJakarta(t.addedAt)}
                            </time>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
