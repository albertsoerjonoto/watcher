import { readSessionUserId } from "@/lib/session";
import { parseFeedFilter } from "@/lib/feed-data";
import { FeedContent } from "@/components/FeedContent";

export const dynamic = "force-dynamic";

// Thin shell. Auth check is the synchronous HMAC-only `readSessionUserId`
// (no DB round-trip, no Prisma lazy-migration on cold start), so the
// function returns in ~5–10ms. Data is loaded client-side by FeedContent's
// SWR with the SWRProvider's localStorage cache.
export default function FeedPage({
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

  return <FeedContent filter={filter} />;
}
