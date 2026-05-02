import { getCurrentUser } from "@/lib/session";
import { parseFeedFilter } from "@/lib/feed-data";
import { FeedContent } from "@/components/FeedContent";

export const dynamic = "force-dynamic";

// Thin shell: auth check only. Data is loaded client-side by FeedContent's
// SWR with the SWRProvider's localStorage cache, so the function returns
// in ~100ms and the user never waits on a 1-2s SSR Prisma round-trip.
// Repeat visits paint instantly from the localStorage cache.
export default async function FeedPage({
  searchParams,
}: {
  searchParams?: { filter?: string | string[] };
}) {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <p className="text-neutral-500 dark:text-neutral-400">
        Sign in to view the feed.
      </p>
    );
  }

  const filter = parseFeedFilter(searchParams?.filter);

  return <FeedContent filter={filter} />;
}
