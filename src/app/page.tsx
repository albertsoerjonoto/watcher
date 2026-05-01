import { getCurrentUser } from "@/lib/session";
import { loadDashboardData } from "@/lib/dashboard-data";
import { DashboardContent } from "@/components/DashboardContent";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) {
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

  // Single fetch shared with /api/dashboard via loadDashboardData(). The
  // SWR client in DashboardContent uses this object as fallbackData so
  // first paint is SSR'd, then revalidates from /api/dashboard.
  const fallbackData = await loadDashboardData(user);

  return <DashboardContent fallbackData={fallbackData} />;
}
