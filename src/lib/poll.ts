// Poll loop for a single playlist. Called from the cron endpoint and the
// manual `scripts/poll-once.ts` helper.
//
// Responsibilities:
//   1. Cheap snapshot_id short-circuit
//   2. Full track fetch + diff against DB
//   3. Persist new Track rows
//   4. Fire web-push for each new track, suppressing self-adds
//   5. Write a PollLog row
//   6. Mark unavailable playlists (404/403) rather than crashing

import { prisma } from "./db";
import {
  fetchAllPlaylistTracks,
  fetchPlaylistMeta,
  SpotifyError,
} from "./spotify";
import { diffTracks, filterSelfAdds, type TrackKeyed } from "./diff";
import { sendPushToUser } from "./push";
import type { Playlist, User } from "@prisma/client";

export interface PollResult {
  playlistId: string;
  skipped: boolean; // snapshot unchanged
  newTracks: number;
  notified: number;
  error?: string;
}

async function loadExistingKeys(playlistId: string): Promise<TrackKeyed[]> {
  const rows = await prisma.track.findMany({
    where: { playlistId },
    select: { spotifyTrackId: true, addedAt: true },
  });
  return rows.map((r) => ({
    spotifyTrackId: r.spotifyTrackId,
    addedAt: r.addedAt,
    title: "",
    artists: [],
    durationMs: 0,
  }));
}

export async function pollPlaylist(
  userIn: User,
  playlist: Playlist,
): Promise<PollResult> {
  const startedAt = Date.now();
  let user = userIn;
  try {
    const meta = await fetchPlaylistMeta(user, playlist.spotifyId);
    user = meta.user;

    // Snapshot short-circuit, but ONLY if we already have tracks in the
    // DB AND we don't have a backfill job to run. Without the backfill
    // gate, tracks added before we started capturing albumImageUrl
    // would never get their artwork because the snapshot would skip
    // the track-fetch step every poll.
    const [haveAnyTracks, missingImages] = await Promise.all([
      prisma.track.count({ where: { playlistId: playlist.id } }),
      prisma.track.count({
        where: { playlistId: playlist.id, albumImageUrl: null },
      }),
    ]);
    if (
      haveAnyTracks > 0 &&
      missingImages === 0 &&
      playlist.snapshotId &&
      playlist.snapshotId === meta.data.snapshot_id
    ) {
      await prisma.playlist.update({
        where: { id: playlist.id },
        data: {
          lastCheckedAt: new Date(),
          name: meta.data.name,
          imageUrl: meta.data.images?.[0]?.url ?? null,
          ownerDisplayName: meta.data.owner.display_name ?? null,
        },
      });
      await prisma.pollLog.create({
        data: {
          playlistId: playlist.id,
          durationMs: Date.now() - startedAt,
          newTracks: 0,
        },
      });
      return {
        playlistId: playlist.id,
        skipped: true,
        newTracks: 0,
        notified: 0,
      };
    }

    const { user: u2, tracks: incoming } = await fetchAllPlaylistTracks(
      user,
      playlist.spotifyId,
    );
    user = u2;

    const existing = await loadExistingKeys(playlist.id);
    const added = diffTracks(existing, incoming);

    // Persist new rows. `firstSeenAt` defaults to now().
    // skipDuplicates is belt-and-suspenders next to the in-memory diff:
    // even if our keyOf normalization ever drifts from the DB roundtrip
    // again, a single stale row should not be allowed to nuke an entire
    // batch via the unique constraint.
    // Backfill albumImageUrl on tracks that were inserted before we
    // started capturing it. updateMany is cheap when no rows match,
    // and we only fire it for tracks where Spotify actually returned
    // an image so a poll on a playlist where the column is already
    // populated does ~zero work.
    const incomingWithImage = incoming.filter((t) => t.albumImageUrl);
    if (incomingWithImage.length) {
      const missingCount = await prisma.track.count({
        where: { playlistId: playlist.id, albumImageUrl: null },
      });
      if (missingCount > 0) {
        for (const t of incomingWithImage) {
          await prisma.track.updateMany({
            where: {
              playlistId: playlist.id,
              spotifyTrackId: t.spotifyTrackId,
              albumImageUrl: null,
            },
            data: { albumImageUrl: t.albumImageUrl },
          });
        }
      }
    }

    if (added.length) {
      await prisma.track.createMany({
        data: added.map((t) => ({
          playlistId: playlist.id,
          spotifyTrackId: t.spotifyTrackId,
          title: t.title,
          artists: JSON.stringify(t.artists),
          album: t.album ?? null,
          albumImageUrl: t.albumImageUrl ?? null,
          durationMs: t.durationMs,
          addedAt:
            t.addedAt instanceof Date ? t.addedAt : new Date(t.addedAt),
          addedBySpotifyId: t.addedBySpotifyId ?? null,
        })),
        skipDuplicates: true,
      });
    }

    // Notify — but suppress self-adds (the owner/authed user).
    const isFirstSeed = !playlist.snapshotId;
    let notified = 0;
    if (!isFirstSeed && playlist.notifyEnabled) {
      const toNotify = filterSelfAdds(added, user.spotifyId);
      for (const t of toNotify) {
        const artistStr = t.artists.join(", ");
        const { sent } = await sendPushToUser(user.id, {
          title: `New in ${meta.data.name}`,
          body: `${t.title} — ${artistStr}`,
          playlistId: playlist.spotifyId,
          trackId: t.spotifyTrackId,
          url: `https://open.spotify.com/track/${t.spotifyTrackId}`,
        });
        if (sent > 0) notified++;
      }
    }

    await prisma.playlist.update({
      where: { id: playlist.id },
      data: {
        snapshotId: meta.data.snapshot_id,
        name: meta.data.name,
        imageUrl: meta.data.images?.[0]?.url ?? null,
        ownerSpotifyId: meta.data.owner.id,
        ownerDisplayName: meta.data.owner.display_name ?? null,
        lastCheckedAt: new Date(),
        status: "active",
      },
    });

    await prisma.pollLog.create({
      data: {
        playlistId: playlist.id,
        durationMs: Date.now() - startedAt,
        newTracks: added.length,
      },
    });

    return {
      playlistId: playlist.id,
      skipped: false,
      newTracks: added.length,
      notified,
    };
  } catch (err: unknown) {
    const status =
      err instanceof SpotifyError ? err.status : 0;
    if (status === 404 || status === 403) {
      await prisma.playlist.update({
        where: { id: playlist.id },
        data: { status: "unavailable", lastCheckedAt: new Date() },
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.pollLog.create({
      data: {
        playlistId: playlist.id,
        durationMs: Date.now() - startedAt,
        newTracks: 0,
        error: msg.slice(0, 1500),
      },
    });
    return {
      playlistId: playlist.id,
      skipped: false,
      newTracks: 0,
      notified: 0,
      error: msg,
    };
  }
}

export async function pollAllForUser(user: User): Promise<PollResult[]> {
  const playlists = await prisma.playlist.findMany({
    where: { userId: user.id, status: "active" },
  });
  const results: PollResult[] = [];
  // Sequential to keep rate-limit pressure sane.
  let u = user;
  for (const p of playlists) {
    const r = await pollPlaylist(u, p);
    results.push(r);
    // Reload user in case token was refreshed in-flight.
    const fresh = await prisma.user.findUnique({ where: { id: u.id } });
    if (fresh) u = fresh;
  }
  return results;
}
