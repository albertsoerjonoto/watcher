// Poll loop for a single playlist. Called from the cron endpoint and the
// manual `scripts/poll-once.ts` helper.
//
// Responsibilities:
//   1. Cheap snapshot_id short-circuit
//   2. Full track fetch + diff against DB
//   3. Persist new Track rows
//   4. Fire web-push for each new track
//   5. Write a PollLog row
//   6. Mark unavailable playlists (404/403) rather than crashing

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  fetchAllPlaylistTracks,
  fetchPlaylistMeta,
  SpotifyError,
} from "./spotify";
import { diffTracks, type TrackKeyed } from "./diff";
import { sendPushToUser } from "./push";
import type { Playlist, User } from "@prisma/client";

export interface PollResult {
  playlistId: string;
  skipped: boolean; // snapshot unchanged
  newTracks: number;
  notified: number;
  error?: string;
}

// Section-level notification gate. AND'd with the per-playlist
// `notifyEnabled` flag in pollPlaylist. Pure helper for unit testing
// — the truth table is small but easy to get wrong if section enums
// drift (e.g. someone introduces a fourth section), so we test it.
export function shouldNotifyForSection(
  user: { notifyMain: boolean; notifyNew: boolean; notifyOther: boolean },
  section: string,
): boolean {
  if (section === "main") return user.notifyMain;
  if (section === "new") return user.notifyNew;
  if (section === "other") return user.notifyOther;
  return false;
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
    console.log(`[poll] ${playlist.name} (${playlist.spotifyId}): starting`);
    const meta = await fetchPlaylistMeta(user, playlist.spotifyId);
    user = meta.user;

    // Snapshot short-circuit, but ONLY if we already have tracks in
    // the DB AND we've already run the one-time albumImageUrl backfill.
    // imageBackfillAt is set after the first full track fetch following
    // the schema migration; without that gate, snapshot-unchanged
    // playlists would never have their art filled in.
    const haveAnyTracks = await prisma.track.count({
      where: { playlistId: playlist.id },
    });
    if (
      haveAnyTracks > 0 &&
      playlist.imageBackfillAt &&
      playlist.snapshotId &&
      playlist.snapshotId === meta.data.snapshot_id
    ) {
      console.log(`[poll] ${playlist.name}: snapshot unchanged, skipping`);
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
    console.log(
      `[poll] ${playlist.name}: snapshot changed (db=${playlist.snapshotId?.slice(0, 12)} → api=${meta.data.snapshot_id?.slice(0, 12)}), fetching tracks`,
    );

    const { user: u2, tracks: incoming } = await fetchAllPlaylistTracks(
      user,
      playlist.spotifyId,
    );
    user = u2;

    // Clean up stale epoch-dated rows before diffing. When the Web API
    // 403s on /tracks, the embed fallback inserts rows with a synthetic
    // addedAt = 1970-01-01 because the embed page doesn't expose real
    // added_at timestamps. Later, when the Pathfinder fallback succeeds
    // and returns the SAME spotifyTrackId with a real addedAt, the
    // (spotifyTrackId, addedAt) composite key treats it as a new row —
    // leaving the playlist with both the stale epoch row and the real
    // one. Delete the stale rows whenever the incoming batch has a real
    // addedAt for the same spotifyTrackId.
    const incomingIdsWithRealDate = incoming
      .filter((t) => {
        const d = t.addedAt instanceof Date ? t.addedAt : new Date(t.addedAt);
        return d.getTime() > 0;
      })
      .map((t) => t.spotifyTrackId);
    if (incomingIdsWithRealDate.length) {
      await prisma.track.deleteMany({
        where: {
          playlistId: playlist.id,
          spotifyTrackId: { in: incomingIdsWithRealDate },
          addedAt: new Date(0),
        },
      });
    }

    const existing = await loadExistingKeys(playlist.id);
    const added = diffTracks(existing, incoming);
    console.log(
      `[poll] ${playlist.name}: existing=${existing.length} incoming=${incoming.length} new=${added.length}`,
    );

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
        // One round-trip per playlist instead of one per track.
        // Sequential awaits timed out at 60s on a 64-track playlist;
        // a parallel Promise.all blew past the connection-pool limit
        // (connection_limit=1 on the transaction pooler). A single
        // SQL UPDATE keyed on a per-playlist VALUES list is O(1)
        // round-trips and stays well inside the function budget.
        const values = incomingWithImage
          .map((t) => Prisma.sql`(${t.spotifyTrackId}, ${t.albumImageUrl})`)
          .reduce((acc, cur, i) =>
            i === 0 ? cur : Prisma.sql`${acc}, ${cur}`,
          );
        await prisma.$executeRaw`
          UPDATE "Track" AS t
          SET "albumImageUrl" = v.img
          FROM (VALUES ${values}) AS v("sid", "img")
          WHERE t."playlistId" = ${playlist.id}
            AND t."spotifyTrackId" = v."sid"
            AND t."albumImageUrl" IS NULL
        `;
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

    const isFirstSeed = !playlist.snapshotId;
    // Section-level notification gate. The user has three master
    // toggles (notifyMain/New/Other), all defaulting ON. AND'd with
    // the per-playlist notifyEnabled flag below.
    const sectionAllowsNotify = shouldNotifyForSection(user, playlist.section);
    let notified = 0;
    console.log(
      `[poll] ${playlist.name}: isFirstSeed=${isFirstSeed} notifyEnabled=${playlist.notifyEnabled} section=${playlist.section} added=${added.length}`,
    );
    if (
      !isFirstSeed &&
      playlist.notifyEnabled &&
      sectionAllowsNotify &&
      added.length > 0
    ) {
      const MAX_SHOWN = 3;
      const lines = added
        .slice(0, MAX_SHOWN)
        .map((t) => `${t.title} — ${t.artists.join(", ")}`);
      if (added.length > MAX_SHOWN) {
        lines.push(`+ ${added.length - MAX_SHOWN} more`);
      }
      const url =
        added.length === 1
          ? `https://open.spotify.com/track/${added[0].spotifyTrackId}`
          : `https://open.spotify.com/playlist/${playlist.spotifyId}`;
      console.log(`[poll] ${playlist.name}: sending batched push (${added.length} tracks)`);
      const { sent, pruned } = await sendPushToUser(user.id, {
        title: meta.data.name,
        body: lines.join("\n"),
        playlistId: playlist.spotifyId,
        url,
      });
      console.log(`[poll] ${playlist.name}: push result sent=${sent} pruned=${pruned}`);
      if (sent > 0) notified++;
    } else if (added.length > 0) {
      console.log(
        `[poll] ${playlist.name}: SKIPPED notifications — isFirstSeed=${isFirstSeed} notifyEnabled=${playlist.notifyEnabled} section=${playlist.section}`,
      );
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
        imageBackfillAt: new Date(),
        status: "active",
      },
    });

    // Post-poll attach: if this playlist isn't yet linked to a WatchedUser
    // (e.g. it was added via POST /api/playlists, which deliberately
    // skips Spotify on the hot path), wire it up now that we know the
    // owner. Auto-create the WatchedUser if needed. Idempotent: if the
    // playlist is already linked, skip.
    if (!playlist.watchedUserId && meta.data.owner.id) {
      const wu = await prisma.watchedUser.upsert({
        where: {
          userId_spotifyId: {
            userId: user.id,
            spotifyId: meta.data.owner.id,
          },
        },
        update: {
          // Backfill displayName if we didn't have one. Don't clobber
          // an existing non-null displayName with another null.
          ...(meta.data.owner.display_name
            ? { displayName: meta.data.owner.display_name }
            : {}),
        },
        create: {
          userId: user.id,
          spotifyId: meta.data.owner.id,
          displayName: meta.data.owner.display_name ?? null,
        },
      });
      await prisma.playlist.update({
        where: { id: playlist.id },
        data: { watchedUserId: wu.id },
      });
    }

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
    // 429 is a transient, app-wide condition: the same cooldown
    // message hits every playlist in a single /api/refresh cycle. We
    // still want the user to see the cooldown on the dashboard, but
    // we don't want five identical red error rows, and we don't want
    // the error to persist once Spotify unblocks us. Collapse 429s
    // into a short-lived PollLog row and leave `lastCheckedAt` alone
    // so the snapshot short-circuit takes over on the next good call.
    if (status === 429) {
      await prisma.pollLog.create({
        data: {
          playlistId: playlist.id,
          durationMs: Date.now() - startedAt,
          newTracks: 0,
          error: msg.slice(0, 200),
        },
      });
      return {
        playlistId: playlist.id,
        skipped: true,
        newTracks: 0,
        notified: 0,
        error: msg,
      };
    }
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

// Safety cap: never poll more than this many playlists per cron run.
//
// History: was 50. Lowered to 25 when section-aware staleness was added,
// because Other-section playlists (~50 per watched user × N users) made
// it realistic to actually exhaust a 50-playlist queue in one tick. At
// 50 playlists × MIN_INTERVAL_MS=500 we'd fire 50 calls in ~25s = 60
// calls per 30s window, exceeding BUDGET_MAX_REQUESTS=20 in src/lib/
// rate-limit.ts. The bucket would reject mid-run with `reason: "budget"`
// (which spotifyFetch does NOT auto-retry; it only auto-retries the
// `interval` reason — see src/lib/rate-limit.ts:290–305).
//
// 25 calls / 12.5s = 50/30s — still over 20/30s on raw count, BUT the
// snapshot short-circuit means the typical poll fires only the meta call
// (1 call/playlist), so realistic throughput is 25 calls / 12.5s ≈
// well within budget. The mismatched-snapshot worst case (25 × 2-3 calls)
// stretches the run to ~60s which is right at maxDuration; that's
// acceptable because a) it's rare and b) any unfinished playlists get
// picked up next cron tick via the lastCheckedAt asc ordering.
//
// Other-section drain math: ~150 Other rows / 25 per run × 1 run/day ≈
// 6 days worst case. Acceptable for a passive-listing section that's
// not on the notification path.
const MAX_PLAYLISTS_PER_RUN = 25;

// Circuit breaker: if this many consecutive playlists fail (non-429),
// abort the remaining polls. Prevents a cascade of failures from
// burning API calls on a systemic issue (e.g. revoked token, Spotify
// outage).
const CIRCUIT_BREAKER_THRESHOLD = 3;

export async function pollAllForUser(user: User): Promise<PollResult[]> {
  // Only poll playlists whose lastCheckedAt is older than the staleness
  // threshold for their section, or that have never been checked at
  // all. Two thresholds:
  //   - Main + New: STALE_THRESHOLD_MS (10 min) — same as before.
  //   - Other:      OTHER_STALE_THRESHOLD_MS (12h) — passive listing,
  //                 polled at most twice/day per playlist.
  //
  // The composed query is a flat OR of (section-set + cutoff) clauses,
  // not a nested OR-of-ORs, because Prisma's nested OR within a single
  // clause doesn't compose with the top-level OR the way you'd expect
  // (it conjuncts inside the clause). Each row is matched by exactly
  // one of the four legs.
  const { STALE_THRESHOLD_MS, OTHER_STALE_THRESHOLD_MS } = await import(
    "./stale"
  );
  const now = Date.now();
  const mainCutoff = new Date(now - STALE_THRESHOLD_MS);
  const otherCutoff = new Date(now - OTHER_STALE_THRESHOLD_MS);
  const playlists = await prisma.playlist.findMany({
    where: {
      userId: user.id,
      status: "active",
      OR: [
        // Main / New: never-checked
        { section: { in: ["main", "new"] }, lastCheckedAt: null },
        // Main / New: stale beyond 10min
        {
          section: { in: ["main", "new"] },
          lastCheckedAt: { lt: mainCutoff },
        },
        // Other: never-checked
        { section: "other", lastCheckedAt: null },
        // Other: stale beyond 12h
        { section: "other", lastCheckedAt: { lt: otherCutoff } },
      ],
    },
    // Deterministic ordering: never-checked playlists first (null sorts
    // before any date in ascending order), then oldest-checked next.
    // Without this, a 429 that short-circuits the loop could
    // repeatedly starve the same playlists.
    orderBy: [{ lastCheckedAt: "asc" }, { createdAt: "asc" }],
    take: MAX_PLAYLISTS_PER_RUN,
  });
  const results: PollResult[] = [];
  // Sequential to keep rate-limit pressure sane.
  let u = user;
  let consecutiveFailures = 0;
  for (const p of playlists) {
    const r = await pollPlaylist(u, p);
    results.push(r);
    // Reload user in case token was refreshed in-flight.
    const fresh = await prisma.user.findUnique({ where: { id: u.id } });
    if (fresh) u = fresh;
    // Short-circuit if we just tripped a 429 — further polls would
    // just bail at assertCanCallSpotify anyway.
    if (r.error?.includes("429") || r.error?.includes("cooldown")) break;
    // Circuit breaker: consecutive non-429 failures suggest a systemic
    // issue (revoked token, Spotify outage, etc.). Abort early to
    // avoid burning API calls on a lost cause.
    if (r.error) {
      consecutiveFailures++;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        console.error(
          `poll circuit breaker: ${consecutiveFailures} consecutive failures, aborting remaining playlists`,
        );
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
  }
  return results;
}
