import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { NotificationToggles } from "@/components/NotificationToggles";
import { SectionNotifyToggles } from "@/components/SectionNotifyToggles";
import { EnablePush } from "@/components/EnablePush";
import { SortModeSetting } from "@/components/SortModeSetting";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return <p className="text-neutral-500 dark:text-neutral-400">Sign in required.</p>;
  // Parallel fan-out — these were sequential, which forced an extra
  // round-trip through the DB connection pooler on every Settings nav
  // and contributed to the multi-second tab-switch lag.
  const [playlists, watchedUsers, subCount] = await Promise.all([
    prisma.playlist.findMany({
      where: { userId: user.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.watchedUser.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.pushSubscription.count({ where: { userId: user.id } }),
  ]);

  // Adds-this-week counts per playlist — feeds the "weekly" sort mode
  // when the user picked it in the dashboard preference.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const playlistIds = playlists.map((p) => p.id);
  const weekCounts =
    playlistIds.length > 0
      ? await prisma.track.groupBy({
          by: ["playlistId"],
          _count: { _all: true },
          where: {
            playlistId: { in: playlistIds },
            addedAt: { gte: since },
          },
        })
      : [];
  const weekByPlaylist = new Map<string, number>();
  for (const w of weekCounts) weekByPlaylist.set(w.playlistId, w._count._all);

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <div className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Account</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Signed in as {user.displayName ?? user.spotifyId}
        </p>
        <form action="/api/auth/logout" method="post">
          <button className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">
            Sign out
          </button>
        </form>
      </div>

      <SortModeSetting />

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Push notifications</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {subCount} device(s) subscribed.
        </p>
        <EnablePush />
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Notify by section</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Master switches per section. A playlist notifies only if its
          section is on AND the playlist itself is enabled below.
        </p>
        <SectionNotifyToggles
          initial={{
            notifyMain: user.notifyMain,
            notifyNew: user.notifyNew,
            notifyOther: user.notifyOther,
          }}
        />
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Per-playlist notifications</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Grouped by watched user and section. The user-row checkbox
          toggles every playlist for that user; section-row toggles
          all in that section. Sort order follows your dashboard
          preference above.
        </p>
        <NotificationToggles
          watchedUsers={watchedUsers.map((wu) => ({
            id: wu.id,
            displayName: wu.displayName,
            spotifyId: wu.spotifyId,
            imageUrl: wu.imageUrl,
          }))}
          playlists={playlists.map((p) => ({
            id: p.id,
            name: p.name,
            notifyEnabled: p.notifyEnabled,
            watchedUserId: p.watchedUserId,
            section: (p.section as "main" | "new" | "other") ?? "main",
            sortOrder: p.sortOrder,
            weekCount: weekByPlaylist.get(p.id) ?? 0,
          }))}
        />
      </div>
    </section>
  );
}
