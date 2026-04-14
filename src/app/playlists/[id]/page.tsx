import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { notFound } from "next/navigation";
import { formatDateJakarta } from "@/lib/datetime";

export const dynamic = "force-dynamic";

type Order = "asc" | "desc";

export default async function PlaylistPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { since?: string; order?: string };
}) {
  const user = await getCurrentUser();
  if (!user) return <p className="text-neutral-400">Sign in required.</p>;
  const playlist = await prisma.playlist.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!playlist) return notFound();

  // Default to "oldest first" — that matches what the user sees in the
  // Spotify app and asked for explicitly. The toggle button at the top
  // flips to "newest first".
  const order: Order = searchParams.order === "desc" ? "desc" : "asc";
  const since = searchParams.since ? new Date(searchParams.since) : null;

  const tracks = await prisma.track.findMany({
    where: {
      playlistId: playlist.id,
      ...(since ? { firstSeenAt: { gte: since } } : {}),
    },
    orderBy: { addedAt: order },
  });

  const otherOrder: Order = order === "asc" ? "desc" : "asc";
  const orderLabel =
    order === "asc" ? "Oldest first" : "Newest first";
  const otherLabel =
    otherOrder === "asc" ? "Oldest first" : "Newest first";

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-4">
        {playlist.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={playlist.imageUrl}
            alt=""
            className="h-20 w-20 shrink-0 rounded object-cover"
          />
        ) : (
          <div className="h-20 w-20 shrink-0 rounded bg-neutral-800" />
        )}
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{playlist.name}</h1>
          <p className="text-xs text-neutral-400">
            {tracks.length} tracks
            {playlist.ownerDisplayName ? ` · by ${playlist.ownerDisplayName}` : ""}
            {since ? ` · since ${formatDateJakarta(since)}` : ""}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Sorted: <span className="text-neutral-300">{orderLabel}</span>
            {" · "}
            <Link
              href={`/playlists/${playlist.id}?order=${otherOrder}`}
              className="text-spotify hover:underline"
            >
              Switch to {otherLabel}
            </Link>
          </p>
        </div>
      </div>
      <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {tracks.map((t, i) => {
          const artists = JSON.parse(t.artists) as string[];
          return (
            <li key={t.id} className="flex items-center gap-3 p-3 text-sm">
              <span className="w-8 text-right text-neutral-500">{i + 1}</span>
              {t.albumImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.albumImageUrl}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded bg-neutral-800" />
              )}
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{t.title}</div>
                <div className="truncate text-xs text-neutral-400">
                  {artists.join(", ")}
                  {t.album ? ` · ${t.album}` : ""}
                </div>
              </div>
              <time className="shrink-0 text-xs text-neutral-500">
                {formatDateJakarta(t.addedAt)}
              </time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
