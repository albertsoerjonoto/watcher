import { readSessionUserId } from "@/lib/session";
import { loadDashboardData } from "@/lib/dashboard-data";
import { DashboardContent } from "@/components/DashboardContent";

export const dynamic = "force-dynamic";

// Auth gate is the synchronous HMAC-only `readSessionUserId` (no DB,
// no Prisma cold-start migration). The data fetch (loadDashboardData)
// runs all queries — including the user lookup — in parallel via
// Promise.all so the cold-start cost is one DB round-trip, not two
// serial. Returning the data inline as fallbackData means the iPhone
// PWA cold launch shows full content, never a skeleton flash.
export default async function DashboardPage() {
  const userId = readSessionUserId();
  if (!userId) {
    return (
      <section className="py-16 text-center">
        <h1 className="mb-4 text-2xl font-semibold">Watcher</h1>
        <p className="mb-6 text-neutral-500 dark:text-neutral-400">
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

  const fallbackData = await loadDashboardData(userId);
  if (!fallbackData) {
    // Stale cookie pointing at a deleted user.
    return (
      <p className="text-neutral-500 dark:text-neutral-400">
        Sign in required.
      </p>
    );
  }

  return <DashboardContent fallbackData={fallbackData} />;
}
