import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import Link from "next/link";
import { dayKeyJakarta, formatDateJakarta } from "@/lib/datetime";
import { TrackLinks } from "@/components/TrackLinks";

export const dynamic = "force-dynamic";

interface FeedRow {
  id: string;
  title: string;
  artists: string;
  albumImageUrl: string | null;
  addedAt: Date;
  playlistId: string;
  playlistName: string;
  section: string;
  spotifyTrackId: string;
}

type Filter = "all" | "main" | "new" | "other";

const FILTER_OPTIONS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "main", label: "Main" },
  { value: "new", label: "New" },
  { value: "other", label: "Other" },
];

function parseFilter(raw: string | string[] | undefined): Filter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "main" || v === "new" || v === "other") return v;
  return "all";
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams?: { filter?: string | string[] };
}) {
  const user = await getCurrentUser();
  if (!user) {
    return <p className="text-neutral-500 dark:text-neutral-400">Sign in to view the feed.</p>;
  }

  const filter = parseFilter(searchParams?.filter);

  // Only show tracks added to Spotify playlists AFTER the user started
  // watching them, using Spotify's real addedAt timestamp.
  const sectionClause =
    filter === "all" ? Prisma.empty : Prisma.sql`AND p."section" = ${filter}`;
  const events = await prisma.$queryRaw<FeedRow[]>(Prisma.sql`
    SELECT t.id, t.title, t.artists, t."albumImageUrl", t."addedAt", t."spotifyTrackId",
           p.id AS "playlistId", p.name AS "playlistName", p."section" AS "section"
    FROM "Track" t
    JOIN "Playlist" p ON t."playlistId" = p.id
    WHERE p."userId" = ${user.id}
      AND t."addedAt" >= p."createdAt"
      ${sectionClause}
    ORDER BY t."addedAt" DESC
    LIMIT 200
  `);

  const groups = new Map<string, FeedRow[]>();
  for (const e of events) {
    const k = dayKeyJakarta(e.addedAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Feed</h1>
        <nav className="flex items-center gap-1 text-xs">
          {FILTER_OPTIONS.map((opt) => {
            const active = opt.value === filter;
            const href = opt.value === "all" ? "/feed" : `/feed?filter=${opt.value}`;
            return (
              <Link
                key={opt.value}
                href={href}
                className={
                  active
                    ? "rounded-full bg-spotify/20 px-3 py-1 font-semibold text-spotify"
                    : "rounded-full px-3 py-1 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
                }
              >
                {opt.label}
              </Link>
            );
          })}
        </nav>
      </div>
      {groups.size === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {filter === "all"
            ? "No tracks yet. Add some playlists from the dashboard."
            : `No tracks in ${filter}.`}
        </p>
      )}
      {Array.from(groups.entries()).map(([day, items]) => (
        <div key={day}>
          <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
            {formatDateJakarta(day)}
          </h2>
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {items.map((e) => {
              const artists = JSON.parse(e.artists) as string[];
              return (
                <li key={e.id} className="flex items-center gap-3 p-3 text-sm">
                  {e.albumImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={e.albumImageUrl}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-9 w-9 shrink-0 rounded bg-neutral-200 dark:bg-neutral-800" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{e.title}</div>
                    <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {artists.join(", ")} ·{" "}
                      <Link
                        href={`/playlists/${e.playlistId}`}
                        className="hover:underline"
                      >
                        {e.playlistName}
                      </Link>
                    </div>
                  </div>
                  <TrackLinks
                    track={{
                      title: e.title,
                      artists: e.artists,
                      spotifyTrackId: e.spotifyTrackId,
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
