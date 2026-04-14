import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PlaylistPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { since?: string };
}) {
  const user = await getCurrentUser();
  if (!user) return <p className="text-neutral-400">Sign in required.</p>;
  const playlist = await prisma.playlist.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!playlist) return notFound();

  const since = searchParams.since ? new Date(searchParams.since) : null;
  const tracks = await prisma.track.findMany({
    where: {
      playlistId: playlist.id,
      ...(since ? { firstSeenAt: { gte: since } } : {}),
    },
    orderBy: { addedAt: "desc" },
    take: 500,
  });

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{playlist.name}</h1>
        <p className="text-xs text-neutral-400">
          {tracks.length} tracks{since ? ` since ${since.toISOString()}` : ""}
        </p>
      </div>
      <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {tracks.map((t, i) => {
          const artists = JSON.parse(t.artists) as string[];
          return (
            <li key={t.id} className="flex items-center gap-3 p-3 text-sm">
              <span className="w-8 text-right text-neutral-500">{i + 1}</span>
              <div className="flex-1">
                <div className="font-medium">{t.title}</div>
                <div className="text-xs text-neutral-400">
                  {artists.join(", ")}
                  {t.album ? ` · ${t.album}` : ""}
                </div>
              </div>
              <time className="text-xs text-neutral-500">
                {new Date(t.addedAt).toLocaleDateString()}
              </time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
