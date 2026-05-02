import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { formatDateTimeJakarta } from "@/lib/datetime";
import { WatchedUserAvatar } from "@/components/WatchedUserAvatar";

export const dynamic = "force-dynamic";

type Order = "asc" | "desc";

const ORPHAN_KEY = "_orphan";

export default async function PlaylistsIndexPage({
  searchParams,
}: {
  searchParams: { order?: string };
}) {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <p className="text-neutral-500 dark:text-neutral-400">Sign in required.</p>
    );
  }

  const order: Order = searchParams.order === "desc" ? "desc" : "asc";
  const otherOrder: Order = order === "asc" ? "desc" : "asc";
  const orderLabel = order === "asc" ? "Oldest first" : "Newest first";
  const otherLabel = otherOrder === "asc" ? "Oldest first" : "Newest first";

  // Fetch watched users + playlists+tracks in parallel. Watched users
  // come from their own table so groups with playlists yet to populate
  // (or all-orphan accounts) still get a header.
  const [watchedUsers, playlists] = await Promise.all([
    prisma.watchedUser.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.playlist.findMany({
      where: { userId: user.id, status: "active" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        tracks: { orderBy: { addedAt: order } },
      },
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

  const totalTracks = playlists.reduce((n, p) => n + p.tracks.length, 0);

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

type PlaylistWithTracks = Prisma.PlaylistGetPayload<{
  include: { tracks: true };
}>;

function WatchedUserGroup({
  label,
  avatar,
  playlists,
}: {
  label: string;
  avatar: React.ReactNode;
  playlists: PlaylistWithTracks[];
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 px-1">
        {avatar}
        <h2 className="min-w-0 truncate text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {label}
        </h2>
      </div>
      <div className="space-y-3">
        {playlists.map((p) => (
          <PlaylistBlock key={p.id} playlist={p} />
        ))}
      </div>
    </div>
  );
}

function PlaylistBlock({ playlist }: { playlist: PlaylistWithTracks }) {
  return (
    <details
      open
      className="group rounded-lg border border-neutral-200 dark:border-neutral-800"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 p-3">
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
            {playlist.tracks.length} tracks
          </div>
        </div>
        <span
          aria-hidden
          className="text-xs text-neutral-400 group-open:rotate-90 transition-transform"
        >
          ▸
        </span>
      </summary>
      {playlist.tracks.length === 0 ? (
        <p className="border-t border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          No tracks yet.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {playlist.tracks.map((t, i) => {
            let artists: string[] = [];
            try {
              artists = JSON.parse(t.artists) as string[];
            } catch {
              artists = [];
            }
            return (
              <li
                key={t.id}
                className="flex items-center gap-3 p-3 text-sm"
              >
                <span className="w-8 text-right text-neutral-500">{i + 1}</span>
                {t.albumImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.albumImageUrl}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded bg-neutral-200 dark:bg-neutral-800" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.title}</div>
                  <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {artists.join(", ")}
                    {t.album ? ` · ${t.album}` : ""}
                  </div>
                </div>
                <time className="shrink-0 text-xs text-neutral-500">
                  {formatDateTimeJakarta(t.addedAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
