import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { AddPlaylistForm } from "@/components/AddPlaylistForm";
import { InstallHint } from "@/components/InstallHint";

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

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const playlists = await prisma.playlist.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { tracks: true } },
    },
  });
  const weekCounts = await prisma.track.groupBy({
    by: ["playlistId"],
    _count: { _all: true },
    where: {
      playlistId: { in: playlists.map((p) => p.id) },
      firstSeenAt: { gte: since },
    },
  });
  const weekByPlaylist = new Map(
    weekCounts.map((r) => [r.playlistId, r._count._all]),
  );

  // Surface the latest poll error per playlist so failures are debuggable
  // from the dashboard itself (useful when Vercel logs aren't accessible).
  const lastErrors = await prisma.pollLog.findMany({
    where: {
      playlistId: { in: playlists.map((p) => p.id) },
      error: { not: null },
    },
    orderBy: { startedAt: "desc" },
    distinct: ["playlistId"],
    select: { playlistId: true, error: true, startedAt: true },
  });
  const errorByPlaylist = new Map(
    lastErrors.map((r) => [r.playlistId, r.error]),
  );

  return (
    <section className="space-y-6">
      <InstallHint />
      <div>
        <h1 className="text-xl font-semibold">Watched playlists</h1>
        <p className="text-sm text-neutral-400">
          Signed in as {user.displayName ?? user.spotifyId}
        </p>
      </div>

      <AddPlaylistForm />

      <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {playlists.length === 0 && (
          <li className="p-4 text-sm text-neutral-400">
            No playlists yet. Paste a Spotify playlist URL above.
          </li>
        )}
        {playlists.map((p) => (
          <li key={p.id} className="flex items-center gap-3 p-4">
            <div className="flex-1">
              <Link
                href={`/playlists/${p.id}`}
                className="font-medium hover:underline"
              >
                {p.name}
              </Link>
              <div className="text-xs text-neutral-400">
                {p._count.tracks} tracks
                {" · "}
                last checked{" "}
                {p.lastCheckedAt
                  ? new Date(p.lastCheckedAt).toLocaleString()
                  : "never"}
                {p.status !== "active" && (
                  <span className="ml-2 text-amber-400">({p.status})</span>
                )}
              </div>
              {errorByPlaylist.get(p.id) && (
                <div className="mt-1 break-all rounded bg-red-950/60 px-2 py-1 font-mono text-[10px] text-red-300">
                  {errorByPlaylist.get(p.id)}
                </div>
              )}
            </div>
            {(weekByPlaylist.get(p.id) ?? 0) > 0 && (
              <span className="rounded-full bg-spotify/20 px-2 py-1 text-xs text-spotify">
                +{weekByPlaylist.get(p.id)} this week
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
