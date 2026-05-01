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
  SpotifyError,
  type SpotifyUserPlaylistItem,
  type SpotifyUserProfile,
} from "./spotify";
import { sendPushToUser } from "./push";
import type { User, WatchedUser } from "@prisma/client";

export interface SyncResult {
  watchedUser: WatchedUser;
  added: number; // newly-discovered playlists in this sync
  total: number; // playlists currently linked to this watched user
  truncated: boolean; // we hit the 200-playlist cap
  notificationsSent: number;
  // Set when ALL 403-tolerant fallbacks failed. The watched user's
  // privacy settings block every Spotify auth path we have. Existing
  // tracked playlists for this user keep being polled normally —
  // sync just can't discover new ones from the user's profile.
  privacyLocked?: boolean;
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
  //
  // Tolerate 403/404 here. Some Spotify users have privacy settings that
  // block third-party apps from reading their profile (`/users/{id}`)
  // even though their public playlists remain accessible via
  // `/users/{id}/playlists`. If profile is unavailable, proceed with a
  // synthetic profile keyed only by user_id — the WatchedUser row will
  // be created without displayName/imageUrl, and the post-poll attach
  // hook in src/lib/poll.ts will backfill displayName from
  // `meta.data.owner.display_name` once any of their playlists polls
  // successfully.
  let user = userIn;
  let profile: SpotifyUserProfile = { id: spotifyUserId };
  try {
    const profileRes = await fetchUserProfile(userIn, spotifyUserId);
    user = profileRes.user;
    profile = profileRes.data;
  } catch (e) {
    if (
      e instanceof SpotifyError &&
      (e.status === 403 || e.status === 404)
    ) {
      console.warn(
        `[syncWatchedUser] profile fetch returned ${e.status} for spotifyUserId=${spotifyUserId} — proceeding without profile metadata; will backfill displayName from playlist owner data once polled`,
      );
    } else {
      throw e;
    }
  }

  // Public playlists (1-4 calls). 404 → user not found, re-throw.
  // 403 → all fallback tiers in fetchUserPublicPlaylists failed
  // (Spotify is privacy-locking this user across user OAuth, app
  // token, and spclient). We DO NOT re-throw on 403 anymore — that
  // would block the watched user entirely. Instead, treat sync as a
  // no-op for this user: leave existing playlists alone (they keep
  // getting polled because individual /playlists/{id} calls still
  // work), update lastSyncedAt, and return privacyLocked=true so
  // the UI can render a soft warning instead of a hard error.
  let fetched: Awaited<ReturnType<typeof fetchUserPublicPlaylists>> | null = null;
  let privacyLocked = false;
  try {
    fetched = await fetchUserPublicPlaylists(user, spotifyUserId);
    user = fetched.user;
  } catch (e) {
    if (e instanceof SpotifyError && e.status === 404) {
      throw new SpotifyError(
        404,
        e.body,
        `Spotify user "${spotifyUserId}" not found.`,
      );
    }
    if (e instanceof SpotifyError && e.status === 403) {
      console.warn(
        `[syncWatchedUser] privacy-locked: all tiers 403 for ${spotifyUserId}. Existing tracked playlists keep polling.`,
      );
      privacyLocked = true;
      // fetched stays null → no new playlists are discovered, but the
      // existing watched-user row + already-attached playlists are
      // unaffected.
    } else {
      throw e;
    }
  }

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
  // insert genuinely new rows. If fetched is null (privacy-locked),
  // newItems stays empty — sync becomes a no-op for this user.
  const newItems: SpotifyUserPlaylistItem[] = [];
  if (fetched) {
    for (const it of fetched.playlists) {
      if (!existingBySpotifyId.has(it.id)) {
        newItems.push(it);
      }
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
    truncated: fetched?.truncated ?? false,
    notificationsSent,
    privacyLocked,
  };
}
