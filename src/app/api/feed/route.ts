// GET /api/feed?filter=all|main|new|other
//
// Returns the feed events (Tracks joined with Playlists) for the
// authenticated user, scoped to tracks added after the playlist was
// first watched. Pure DB reads — no Spotify calls.
//
// Mirrors /api/dashboard. The SWR cache key is FEED_KEY(filter)
// from src/components/feed-keys.ts.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { loadFeedData, parseFeedFilter } from "@/lib/feed-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const filter = parseFeedFilter(
    request.nextUrl.searchParams.get("filter") ?? undefined,
  );
  const data = await loadFeedData(user, filter);
  return NextResponse.json(data);
}
