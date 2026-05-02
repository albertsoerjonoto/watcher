import { readSessionUserId } from "@/lib/session";
import { loadFeedData, parseFeedFilter } from "@/lib/feed-data";
import { FeedContent } from "@/components/FeedContent";

export const dynamic = "force-dynamic";

// Auth gate is sync HMAC, then loadFeedData runs the JOIN. Result is
// inlined as fallbackData so cold launches never show the skeleton.
export default async function FeedPage({
  searchParams,
}: {
  searchParams?: { filter?: string | string[] };
}) {
  const userId = readSessionUserId();
  if (!userId) {
    return (
      <p className="text-neutral-500 dark:text-neutral-400">
        Sign in to view the feed.
      </p>
    );
  }

  const filter = parseFeedFilter(searchParams?.filter);
  const fallbackData = await loadFeedData(userId, filter);

  return <FeedContent filter={filter} fallbackData={fallbackData} />;
}
