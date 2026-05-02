import { getCurrentUser } from "@/lib/session";
import { loadFeedData, parseFeedFilter } from "@/lib/feed-data";
import { FeedContent } from "@/components/FeedContent";

export const dynamic = "force-dynamic";

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

  // SSR fallback shared with /api/feed via loadFeedData(). The SWR
  // client in FeedContent uses this object as fallbackData so first
  // paint is SSR'd, then revalidates from /api/feed. Repeat visits
  // hit the SWRProvider's localStorage cache and skip the network.
  const fallbackData = await loadFeedData(user, filter);

  return <FeedContent filter={filter} fallbackData={fallbackData} />;
}
