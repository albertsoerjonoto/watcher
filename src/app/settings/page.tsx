import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { NotificationToggles } from "@/components/NotificationToggles";
import { EnablePush } from "@/components/EnablePush";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return <p className="text-neutral-500 dark:text-neutral-400">Sign in required.</p>;
  // Parallel fan-out — these were sequential, which forced an extra
  // round-trip through the DB connection pooler on every Settings nav
  // and contributed to the multi-second tab-switch lag.
  const [playlists, subCount] = await Promise.all([
    prisma.playlist.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.pushSubscription.count({ where: { userId: user.id } }),
  ]);

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

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Push notifications</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {subCount} device(s) subscribed.
        </p>
        <EnablePush />
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Per-playlist notifications</h2>
        <NotificationToggles
          playlists={playlists.map((p) => ({
            id: p.id,
            name: p.name,
            notifyEnabled: p.notifyEnabled,
          }))}
        />
      </div>
    </section>
  );
}
