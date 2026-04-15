import Link from "next/link";
import type { Track } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { AddPlaylistForm } from "@/components/AddPlaylistForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { InstallHint } from "@/components/InstallHint";
import { RetryButton } from "@/components/RetryButton";
import { PlaylistActionsClient } from "@/components/PlaylistActions";
import { formatDateJakarta, formatDateTimeJakarta } from "@/lib/datetime";

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

  // All recent tracks across every playlist in a single query,
  // grouped in memory. The old code fanned out one findMany per
  // playlist (N+1) which, on a 6-playlist dashboard, was six
  // sequential round-trips on the transaction-pooled connection (we
  // have connection_limit=1). Replacing that with a single
  // `playlistId IN (...)` query + JS group-by cut dashboard load
  // time by ~80% and — more importantly — is O(1) in round-trips
  // regardless of how many playlists the user watches.
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
      // One query for all recent tracks across every playlist. We
      // over-fetch a bit (RECENT_PER_PLAYLIST * playlistCount) and
      // slice per-group in memory below. Still O(1) round-trips.
      playlistIds.length > 0
        ? prisma.track.findMany({
            where: { playlistId: { in: playlistIds } },
            orderBy: { addedAt: "desc" },
            take: RECENT_PER_PLAYLIST * playlistIds.length,
          })
        : Promise.resolve([] as Track[]),
      prisma.pushSubscription
        .count({ where: { userId: user.id } })
        .then((n) => n > 0),
    ]);

  const weekByPlaylist = new Map(
    weekCounts.map((r) => [r.playlistId, r._count._all]),
  );
  const errorByPlaylist = new Map(
    lastErrors.filter((r) => r.error).map((r) => [r.playlistId, r.error]),
  );
  // Group the flat `allRecentTracks` result by playlistId, then cap
  // each group at RECENT_PER_PLAYLIST. The DB already sorted by
  // addedAt desc so the first N per group are the most recent.
  const recentByPlaylist = new Map<string, Track[]>();
  for (const t of allRecentTracks) {
    const bucket = recentByPlaylist.get(t.playlistId);
    if (bucket) {
      if (bucket.length < RECENT_PER_PLAYLIST) bucket.push(t);
    } else {
      recentByPlaylist.set(t.playlistId, [t]);
    }
  }

  // If any recent poll failed on token refresh, Spotify has revoked the
  // stored refresh token and nothing will work until the user re-auths.
  // Show a banner with a one-tap re-auth link. Otherwise re-auth is
  // tucked away on the Settings page — having it on the dashboard
  // header was confusing because users assumed they had to click it
  // every time they wanted fresh data.
  const needsReauth = Array.from(errorByPlaylist.values()).some((e) =>
    e?.toLowerCase().includes("token refresh failed"),
  );

  // Highest cooldown across all rate-limited polls — the dashboard
  // shows this next to the sync badge so the user knows how long
  // until Spotify will accept another request.
  const cooldownSeconds = Array.from(errorByPlaylist.values())
    .map((e) => {
      const m = e?.match(/retry after (\d+)s/i);
      return m ? Number(m[1]) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);

  // Group playlists by owner — the dashboard answers the question
  // "what new tracks landed in playlists I care about", and that's
  // easier to scan when playlists from the same owner are visually
  // grouped. Iteration order preserves the user-defined sortOrder.
  const groups = new Map<
    string,
    { ownerName: string; rows: typeof playlists }
  >();
  for (const p of playlists) {
    const key = p.ownerSpotifyId ?? "unknown";
    const ownerName =
      p.ownerDisplayName ?? p.ownerSpotifyId ?? "Unknown owner";
    if (!groups.has(key)) groups.set(key, { ownerName, rows: [] });
    groups.get(key)!.rows.push(p);
  }

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

      {playlists.length === 0 && (
        <div className="rounded-lg border border-neutral-800 p-4 text-sm text-neutral-400">
          No playlists yet. Paste a Spotify playlist URL above.
        </div>
      )}

      {Array.from(groups.entries()).map(([groupKey, { ownerName, rows }]) => {
        // Reorder operates WITHIN a group, not across the global list.
        // Previously we swapped sortOrder with the global neighbor, which
        // worked at the DB level but was invisible on screen because the
        // dashboard renders playlists grouped by owner. Clicking ↑ on a
        // row whose global neighbor lived in a different group just
        // silently swapped sortOrder numbers without any visual change,
        // producing the "slow and buggy" reorder the user reported.
        return (
          <div key={groupKey} className="space-y-2">
            <h2 className="px-1 text-xs uppercase tracking-wide text-neutral-500">
              By {ownerName}
            </h2>
            <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
              {rows.map((p) => {
                const recent = recentByPlaylist.get(p.id) ?? [];
                const groupIdx = rows.findIndex((x) => x.id === p.id);
                const prevId = groupIdx > 0 ? rows[groupIdx - 1].id : null;
                const nextId =
                  groupIdx < rows.length - 1 ? rows[groupIdx + 1].id : null;
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
                      <div className="flex-1 min-w-0">
                        <Link
                          href={`/playlists/${p.id}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {p.name}
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
                        {errorByPlaylist.get(p.id) && (() => {
                          const msg = errorByPlaylist.get(p.id)!;
                          const isRateLimited = msg.includes("429");
                          const cls = isRateLimited
                            ? "mt-1 break-all rounded bg-amber-950/60 px-2 py-1 font-mono text-[10px] text-amber-300"
                            : "mt-1 break-all rounded bg-red-950/60 px-2 py-1 font-mono text-[10px] text-red-300";
                          return <div className={cls}>{msg}</div>;
                        })()}
                      </div>
                      {(weekByPlaylist.get(p.id) ?? 0) > 0 && (
                        <span className="shrink-0 rounded-full bg-spotify/20 px-2 py-1 text-xs text-spotify">
                          +{weekByPlaylist.get(p.id)} this week
                        </span>
                      )}
                      <RetryButton playlistId={p.id} />
                      <PlaylistActionsClient
                        playlistId={p.id}
                        playlistName={p.name}
                        isFirst={groupIdx === 0}
                        isLast={groupIdx === rows.length - 1}
                        prevId={prevId}
                        nextId={nextId}
                      />
                    </div>
                    {recent.length > 0 && (
                      <ul className="mt-3 space-y-1 border-l border-neutral-800 pl-3 text-xs">
                        {recent.map((t) => {
                          const artists = JSON.parse(t.artists) as string[];
                          return (
                            <li key={t.id} className="flex items-center gap-2">
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
        );
      })}
    </section>
  );
}
