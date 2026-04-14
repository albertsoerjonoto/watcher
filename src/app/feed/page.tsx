import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import Link from "next/link";
import { dayKeyJakarta, formatDateJakarta } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function FeedPage() {
  const user = await getCurrentUser();
  if (!user) {
    return <p className="text-neutral-400">Sign in to view the feed.</p>;
  }
  const events = await prisma.track.findMany({
    where: { playlist: { userId: user.id } },
    orderBy: { firstSeenAt: "desc" },
    take: 200,
    include: { playlist: { select: { id: true, name: true } } },
  });

  const groups = new Map<string, typeof events>();
  for (const e of events) {
    const k = dayKeyJakarta(e.firstSeenAt);
    if (!groups.has(k)) groups.set(k, [] as typeof events);
    groups.get(k)!.push(e);
  }

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Feed</h1>
      {groups.size === 0 && (
        <p className="text-sm text-neutral-400">
          No tracks yet. Add some playlists from the dashboard.
        </p>
      )}
      {Array.from(groups.entries()).map(([day, items]) => (
        <div key={day}>
          <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
            {formatDateJakarta(day)}
          </h2>
          <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {items.map((e) => {
              const artists = JSON.parse(e.artists) as string[];
              return (
                <li key={e.id} className="flex items-center gap-3 p-3 text-sm">
                  {e.albumImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={e.albumImageUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-10 w-10 shrink-0 rounded bg-neutral-800" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{e.title}</div>
                    <div className="truncate text-xs text-neutral-400">
                      {artists.join(", ")} ·{" "}
                      <Link
                        href={`/playlists/${e.playlist.id}`}
                        className="hover:underline"
                      >
                        {e.playlist.name}
                      </Link>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
