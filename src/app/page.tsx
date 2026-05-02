import { readSessionUserId } from "@/lib/session";
import { DashboardContent } from "@/components/DashboardContent";

export const dynamic = "force-dynamic";

// Thin shell. Auth check is the synchronous HMAC-only `readSessionUserId`
// (no DB round-trip, no Prisma lazy-migration on cold start), so the
// function returns in ~5–10ms. Data is loaded client-side.
export default function DashboardPage() {
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

  return <DashboardContent />;
}
