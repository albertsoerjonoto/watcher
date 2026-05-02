// SWR cache key for feed data fetches. One key per filter so that
// switching filters (e.g. All ↔ Main) keeps each filter's cache warm.
// Mirrors the dashboard-keys.ts pattern.

import type { FeedFilter } from "@/lib/feed-data";

export const FEED_KEY = (filter: FeedFilter) =>
  filter === "all" ? "/api/feed" : `/api/feed?filter=${filter}`;
