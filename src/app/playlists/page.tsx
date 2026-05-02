import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { readSessionUserId } from "@/lib/session";
import { WatchedUserAvatar } from "@/components/WatchedUserAvatar";

export const dynamic = "force-dynamic";

type Order = "asc" | "desc";

const ORPHAN_KEY = "_orphan";

export default async function PlaylistsIndexPage({
  searchParams,
}: {
  searchParams: { order?: string };
}) {
  // Sync HMAC — no DB query, no Prisma migration trigger on cold start.
  const userId = readSessionUserId();
  if (!userId) {
    return (
      <p className="text-neutral-500 dark:text-neutral-400">Sign in required.</p>
    );
  }

  const order: Order = searchParams.order === "desc" ? "desc" : "asc";
  const otherOrder: Order = order === "asc" ? "desc" : "asc";
  const orderLabel = order === "asc" ? "Oldest first" : "Newest first";
  const otherLabel = otherOrder === "asc" ? "Oldest first" : "Newest first";

  // Index page only needs the playlist meta + track COUNTS, not the
  // tracks themselves. Inlining 2293 tracks balloons the SSR HTML to
  // ~3.4 MB and pushes FCP to 2-3 seconds even on a fast connection;
  // tracks live on /playlists/[id] anyway. The count comes from
  // _count, which Prisma resolves with a single aggregate per row.
  const [watchedUsers, playlists] = await Promise.all([
    prisma.watchedUser.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.playlist.findMany({
      where: { userId, status: "active" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { tracks: true } } },
    }),
  ]);

  // Group playlists by watchedUserId; orphans (not yet polled) bucket
  // under ORPHAN_KEY and render last.
  const playlistsByWatchedUser = new Map<string, typeof playlists>();
  for (const p of playlists) {
    const key = p.watchedUserId ?? ORPHAN_KEY;
    const bucket = playlistsByWatchedUser.get(key);
    if (bucket) bucket.push(p);
    else playlistsByWatchedUser.set(key, [p]);
  }

  const totalTracks = playlists.reduce((n, p) => n + p._count.tracks, 0);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Playlists</h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {playlists.length} playlists · {totalTracks} tracks
        </p>
        <p className="text-xs text-neutral-500">
          Sorted:{" "}
          <span className="text-neutral-700 dark:text-neutral-300">
            {orderLabel}
          </span>
          {" · "}
          <Link
            href={`/playlists?order=${otherOrder}`}
            className="text-spotify hover:underline"
          >
            Switch to {otherLabel}
          </Link>
        </p>
      </div>

      {watchedUsers.map((wu) => {
        const group = playlistsByWatchedUser.get(wu.id) ?? [];
        if (group.length === 0) return null;
        return (
          <WatchedUserGroup
            key={wu.id}
            label={wu.displayName ?? wu.spotifyId ?? "Unknown"}
            avatar={
              <WatchedUserAvatar
                imageUrl={wu.imageUrl}
                displayName={wu.displayName}
                spotifyId={wu.spotifyId}
                size="md"
              />
            }
            playlists={group}
            order={order}
          />
        );
      })}

      {(() => {
        const orphans = playlistsByWatchedUser.get(ORPHAN_KEY) ?? [];
        if (orphans.length === 0) return null;
        return (
          <WatchedUserGroup
            key={ORPHAN_KEY}
            label="Not yet polled"
            avatar={
              <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-700" />
            }
            playlists={orphans}
            order={order}
          />
        );
      })()}

      {playlists.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No playlists yet. Add one from the Dashboard.
        </p>
      )}
    </section>
  );
}

type PlaylistWithCount = Prisma.PlaylistGetPayload<{
  include: { _count: { select: { tracks: true } } };
}>;

function WatchedUserGroup({
  label,
  avatar,
  playlists,
  order,
}: {
  label: string;
  avatar: React.ReactNode;
  playlists: PlaylistWithCount[];
  order: Order;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 px-1">
        {avatar}
        <h2 className="min-w-0 truncate text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {label}
        </h2>
      </div>
      <div className="space-y-2">
        {playlists.map((p) => (
          <PlaylistCard key={p.id} playlist={p} order={order} />
        ))}
      </div>
    </div>
  );
}

function PlaylistCard({
  playlist,
  order,
}: {
  playlist: PlaylistWithCount;
  order: Order;
}) {
  const href =
    order === "desc"
      ? `/playlists/${playlist.id}?order=desc`
      : `/playlists/${playlist.id}`;
  const trackCount = playlist._count.tracks;
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
    >
      {playlist.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={playlist.imageUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
      ) : (
        <div className="h-10 w-10 shrink-0 rounded bg-neutral-200 dark:bg-neutral-800" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{playlist.name}</div>
        <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
          {trackCount} {trackCount === 1 ? "track" : "tracks"}
        </div>
      </div>
      <span
        aria-hidden
        className="text-xs text-neutral-400"
      >
        ›
      </span>
    </Link>
  );
}
