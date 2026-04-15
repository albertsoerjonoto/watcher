import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { parsePlaylistId } from "@/lib/spotify";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const playlists = await prisma.playlist.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { tracks: true } } },
  });
  return NextResponse.json({ playlists });
}

const AddSchema = z.object({
  url: z.string().min(1),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const body = AddSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const spotifyId = parsePlaylistId(body.data.url);
  if (!spotifyId) {
    return NextResponse.json(
      { error: "could not parse playlist id" },
      { status: 400 },
    );
  }

  // Pick a sortOrder that puts the new playlist at the end so existing
  // ordering is preserved. We do this on insert only — the dashboard's
  // Move ↑/↓ buttons own all subsequent ordering changes.
  const max = await prisma.playlist.aggregate({
    where: { userId: user.id },
    _max: { sortOrder: true },
  });
  const nextSortOrder = (max._max.sortOrder ?? 0) + 1;

  // No Spotify calls on the hot path. A previous version fetched
  // playlist meta here to pre-populate name/owner and guard against
  // Spotify-owned editorial playlists, but Spotify was rate-limiting
  // the meta endpoint (up to 2 minutes of Retry-After backoff) and
  // the whole Add button hung on it. Insert a stub row keyed by the
  // parsed spotifyId and let the background retry hydrate meta and
  // tracks. Editorial-playlist detection moves to pollPlaylist which
  // already marks 403s as "unavailable".
  const playlist = await prisma.playlist.upsert({
    where: { userId_spotifyId: { userId: user.id, spotifyId } },
    update: { status: "active" },
    create: {
      userId: user.id,
      spotifyId,
      // Use the Spotify id as a placeholder name; pollPlaylist
      // overwrites it with meta.name on the first successful fetch.
      name: spotifyId,
      sortOrder: nextSortOrder,
    },
  });

  // Do NOT seed tracks here. Pathfinder-fallback playlists can take
  // 10–30s to fully fetch, and a large playlist exceeds Vercel's 60s
  // function timeout entirely. Instead, return immediately with the
  // bare playlist row (0 tracks) so the UI renders the new card
  // instantly. The client fires `/api/playlists/:id/retry` in the
  // background to seed tracks; the dashboard's AutoRefresh picks up
  // the new rows on its next tick.
  return NextResponse.json({ playlist });
}
