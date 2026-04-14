import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { AddPlaylistForm } from "@/components/AddPlaylistForm";
import { InstallHint } from "@/components/InstallHint";
import { RetryButton } from "@/components/RetryButton";

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

  // Last 5 tracks per playlist, shown inline on the dashboard so the user
  // can see what's in each watched playlist without clicking through.
  const recentTracksPerPlaylist = await Promise.all(
    playlists.map((p) =>
      prisma.track.findMany({
        where: { playlistId: p.id },
        orderBy: { addedAt: "desc" },
        take: 5,
      }),
    ),
  );
  const recentByPlaylist = new Map(
    playlists.map((p, i) => [p.id, recentTracksPerPlaylist[i]]),
  );

  // If any recent poll failed on token refresh, Spotify has revoked the
  // stored refresh token and nothing will work until the user re-auths.
  // Show a prominent banner with a one-tap re-auth link.
  const needsReauth = Array.from(errorByPlaylist.values()).some((e) =>
    e?.toLowerCase().includes("token refresh failed"),
  );

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
      <div>
        <h1 className="text-xl font-semibold">Watched playlists</h1>
        <p className="text-sm text-neutral-400">
          Signed in as {user.displayName ?? user.spotifyId}
          {" · "}
          <a href="/api/auth/login" className="underline hover:text-neutral-200">
            re-auth
          </a>
        </p>
      </div>

      <AddPlaylistForm />

      <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {playlists.length === 0 && (
          <li className="p-4 text-sm text-neutral-400">
            No playlists yet. Paste a Spotify playlist URL above.
          </li>
        )}
        {playlists.map((p) => {
          const recent = recentByPlaylist.get(p.id) ?? [];
          return (
            <li key={p.id} className="p-4">
              <div className="flex items-center gap-3">
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
                <RetryButton playlistId={p.id} />
              </div>
              {recent.length > 0 && (
                <ul className="mt-3 space-y-1 border-l border-neutral-800 pl-3 text-xs">
                  {recent.map((t) => {
                    const artists = JSON.parse(t.artists) as string[];
                    return (
                      <li key={t.id} className="flex gap-2">
                        <span className="flex-1 truncate">
                          <span className="text-neutral-200">{t.title}</span>
                          <span className="text-neutral-500">
                            {" — "}
                            {artists.join(", ")}
                          </span>
                        </span>
                        <time className="shrink-0 text-neutral-600">
                          {new Date(t.addedAt).toLocaleDateString()}
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
    </section>
  );
}
