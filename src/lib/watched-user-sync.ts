// Shared add/sync logic for the WatchedUser feature.
//
// Both POST /api/watched-users (initial add) and
// POST /api/watched-users/:id/sync (re-discover) call into syncWatchedUser
// — the only difference is whether `WatchedUser.lastSyncedAt` was already
// set on entry. First sync (lastSyncedAt = null) suppresses the new-
// playlist push so the user doesn't get 53 notifications when they add
// a new watched user.

import { prisma } from "./db";
import {
  fetchUserProfile,
  fetchUserPublicPlaylists,
  type SpotifyUserPlaylistItem,
} from "./spotify";
import { sendPushToUser } from "./push";
import type { User, WatchedUser } from "@prisma/client";

export interface SyncResult {
  watchedUser: WatchedUser;
  added: number; // newly-discovered playlists in this sync
  total: number; // playlists currently linked to this watched user
  truncated: boolean; // we hit the 200-playlist cap
  notificationsSent: number;
}

/**
 * Fetch the watched user's profile + public playlists and reconcile
 * against existing rows.
 *
 * Behavior:
 *   - First sync (lastSyncedAt was null): every playlist lands in
 *     section="other". No notifications. Sets lastSyncedAt on success.
 *   - Subsequent syncs: any playlist not previously linked to this
 *     watched user is inserted in section="new" and a push is sent
 *     ("X just shared a new playlist: Y"). Already-linked playlists
 *     are left alone (we never demote an existing Main playlist).
 *
 * Rate-limit shape: 1 profile call + up to 4 paginated calls, all gated
 * by spotifyFetch. Caller MUST gate against getCooldownSeconds() before
 * invoking — we intentionally don't repeat that check here so this
 * function stays pure with respect to its inputs.
 */
export async function syncWatchedUser(
  userIn: User,
  spotifyUserId: string,
): Promise<SyncResult> {
  // Look up existing row so we can decide first-sync vs subsequent.
  const existing = await prisma.watchedUser.findUnique({
    where: { userId_spotifyId: { userId: userIn.id, spotifyId: spotifyUserId } },
  });
  const isFirstSync = existing == null || existing.lastSyncedAt == null;

  // Profile (1 call). May rotate the access token.
  const profileRes = await fetchUserProfile(userIn, spotifyUserId);
  let user = profileRes.user;
  const profile = profileRes.data;

  // Public playlists (1-4 calls).
  const fetched = await fetchUserPublicPlaylists(user, spotifyUserId);
  user = fetched.user;

  // Upsert the WatchedUser row with the freshly-fetched profile metadata.
  const watchedUser = await prisma.watchedUser.upsert({
    where: { userId_spotifyId: { userId: user.id, spotifyId: spotifyUserId } },
    update: {
      displayName: profile.display_name ?? null,
      imageUrl: profile.images?.[0]?.url ?? null,
    },
    create: {
      userId: user.id,
      spotifyId: spotifyUserId,
      displayName: profile.display_name ?? null,
      imageUrl: profile.images?.[0]?.url ?? null,
    },
  });

  // Read currently-linked playlists for this watched user. We diff
  // against this set to decide what's new.
  const existingPlaylists = await prisma.playlist.findMany({
    where: { userId: user.id, watchedUserId: watchedUser.id },
    select: { id: true, spotifyId: true },
  });
  const existingBySpotifyId = new Map(
    existingPlaylists.map((p) => [p.spotifyId, p.id]),
  );

  // Decide what's new vs. already-tracked. Anything we already track
  // for THIS user (any section) keeps its current section; we only
  // insert genuinely new rows.
  const newItems: SpotifyUserPlaylistItem[] = [];
  for (const it of fetched.playlists) {
    if (!existingBySpotifyId.has(it.id)) {
      newItems.push(it);
    }
  }

  // Insert new playlists. Section depends on whether this is the first
  // sync (everything is back-catalogue → "other") or a re-sync (this
  // is genuinely new content the watched user just shared → "new").
  // Use upsert keyed on (userId, spotifyId) — if the user already has
  // a Playlist with the same spotifyId attached to a DIFFERENT watched
  // user (rare, but possible if owners change), we re-attach without
  // duplicating.
  const targetSection = isFirstSync ? "other" : "new";
  for (const it of newItems) {
    await prisma.playlist.upsert({
      where: {
        userId_spotifyId: { userId: user.id, spotifyId: it.id },
      },
      update: {
        watchedUserId: watchedUser.id,
        // Only refresh metadata; never auto-flip section on an
        // existing row (that's the user's manual call).
        name: it.name,
        imageUrl: it.images?.[0]?.url ?? null,
        ownerSpotifyId: it.owner.id,
        ownerDisplayName: it.owner.display_name ?? null,
        status: "active",
      },
      create: {
        userId: user.id,
        watchedUserId: watchedUser.id,
        spotifyId: it.id,
        name: it.name,
        imageUrl: it.images?.[0]?.url ?? null,
        ownerSpotifyId: it.owner.id,
        ownerDisplayName: it.owner.display_name ?? null,
        snapshotId: it.snapshot_id ?? null,
        section: targetSection,
        // Discovered fresh — leave lastCheckedAt null so the next
        // poll fetches tracks (and respects first-seed silence in
        // pollPlaylist for Main/New).
      },
    });
  }

  // Stamp lastSyncedAt only after the inserts succeed. If something
  // throws above, we want a re-run to also be treated as first-sync.
  await prisma.watchedUser.update({
    where: { id: watchedUser.id },
    data: { lastSyncedAt: new Date() },
  });

  // Fire push notifications for newly-discovered playlists, but only
  // on subsequent syncs — first sync would spam 50+ pushes.
  let notificationsSent = 0;
  if (!isFirstSync && newItems.length > 0) {
    const ownerLabel =
      profile.display_name ?? watchedUser.displayName ?? spotifyUserId;
    for (const it of newItems) {
      const r = await sendPushToUser(user.id, {
        title: `${ownerLabel} just shared a new playlist`,
        body: it.name,
        url: `/`,
      });
      notificationsSent += r.sent;
    }
  }

  const total = await prisma.playlist.count({
    where: { userId: user.id, watchedUserId: watchedUser.id },
  });

  return {
    watchedUser,
    added: newItems.length,
    total,
    truncated: fetched.truncated,
    notificationsSent,
  };
}
