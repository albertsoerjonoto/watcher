import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { fetchPlaylistMeta, parsePlaylistId } from "@/lib/spotify";
import { pollPlaylist } from "@/lib/poll";

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

  const playlist = await prisma.playlist.upsert({
    where: { userId_spotifyId: { userId: user.id, spotifyId } },
    update: { name: meta.name, ownerSpotifyId: meta.owner.id, status: "active" },
    create: {
      userId: user.id,
      spotifyId,
      name: meta.name,
      ownerSpotifyId: meta.owner.id,
    },
  });

  // Seed tracks synchronously. snapshotId is null on first run → pollPlaylist
  // will persist rows but *not* send notifications (isFirstSeed guard).
  await pollPlaylist(user, playlist);

  return NextResponse.json({ playlist });
}
