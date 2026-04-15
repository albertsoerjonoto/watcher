import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { fetchPlaylistMeta, parsePlaylistId } from "@/lib/spotify";

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

  const { data: meta } = await fetchPlaylistMeta(user, spotifyId);

  // Spotify's Nov 2024 policy change blocks dev-mode apps from reading
  // tracks on Spotify-owned editorial/algorithmic playlists (owner id
  // "spotify"). Metadata still resolves, but /tracks returns 403. Fail
  // fast with a clear message rather than silently marking unavailable.
  if (meta.owner.id === "spotify") {
    return NextResponse.json(
      {
        error:
          "This is a Spotify-owned editorial playlist. Since Nov 2024, Spotify blocks dev-mode apps from reading its tracks. Watch a user-owned playlist instead.",
      },
      { status: 422 },
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

  const playlist = await prisma.playlist.upsert({
    where: { userId_spotifyId: { userId: user.id, spotifyId } },
    update: {
      name: meta.name,
      ownerSpotifyId: meta.owner.id,
      ownerDisplayName: meta.owner.display_name ?? null,
      imageUrl: meta.images?.[0]?.url ?? null,
      status: "active",
    },
    create: {
      userId: user.id,
      spotifyId,
      name: meta.name,
      ownerSpotifyId: meta.owner.id,
      ownerDisplayName: meta.owner.display_name ?? null,
      imageUrl: meta.images?.[0]?.url ?? null,
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
