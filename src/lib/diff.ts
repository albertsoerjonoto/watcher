// Diff logic — the critical path.
//
// A playlist track is uniquely identified inside a playlist by the tuple
// (spotifyTrackId, addedAt). We *cannot* use trackId alone because the same
// song can be added to a playlist multiple times (Spotify allows duplicates)
// and we want each addition to count as a separate "new" event.
//
// We also surface `addedBySpotifyId` so the caller can filter notifications
// (e.g. suppress tracks the authed user added themselves).

export interface TrackKeyed {
  spotifyTrackId: string;
  addedAt: string | Date; // ISO string or Date
  title: string;
  artists: string[];
  album?: string | null;
  durationMs: number;
  addedBySpotifyId?: string | null;
}

function keyOf(t: Pick<TrackKeyed, "spotifyTrackId" | "addedAt">): string {
  // CRITICAL: normalize both sides through Date so the key is stable
  // regardless of source. Spotify returns ISO strings without
  // milliseconds ("2026-04-14T07:42:08Z") and Postgres roundtrips them
  // through Date, which serializes back as "2026-04-14T07:42:08.000Z".
  // Comparing the raw string to the .toISOString() output causes every
  // already-stored track to look "new" on the next poll, which then
  // explodes the entire batch via the (playlistId, spotifyTrackId,
  // addedAt) unique constraint on createMany.
  const d = t.addedAt instanceof Date ? t.addedAt : new Date(t.addedAt);
  const ts = isNaN(d.getTime()) ? String(t.addedAt) : d.toISOString();
  return `${t.spotifyTrackId}@${ts}`;
}

/**
 * Given the previously-known tracks and the freshly-fetched tracks for a
 * playlist, return the ones that are newly present.
 *
 * The return preserves the order of `incoming` (Spotify returns tracks in
 * playlist order) so callers can notify in-order.
 */
export function diffTracks<T extends TrackKeyed>(
  existing: readonly TrackKeyed[],
  incoming: readonly T[],
): T[] {
  const seen = new Set<string>();
  for (const t of existing) seen.add(keyOf(t));
  const added: T[] = [];
  for (const t of incoming) {
    const k = keyOf(t);
    if (!seen.has(k)) {
      added.push(t);
      // Guard against duplicates *within* the incoming page.
      seen.add(k);
    }
  }
  return added;
}

/**
 * Filter out tracks the given spotify user added themselves. Used to honor
 * the "owner won't be notified" requirement — the authenticated user should
 * not be pinged about their own additions.
 */
export function filterSelfAdds<T extends TrackKeyed>(
  tracks: readonly T[],
  selfSpotifyId: string | null | undefined,
): T[] {
  if (!selfSpotifyId) return [...tracks];
  return tracks.filter((t) => t.addedBySpotifyId !== selfSpotifyId);
}
