import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { pollPlaylist } from "@/lib/poll";

// POST /api/playlists/:id/retry
//
// Resets a playlist to "active" and runs a fresh poll immediately.
// Used by the dashboard's "Retry" button so the user doesn't have to
// re-paste the URL when a previous poll errored.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const playlist = await prisma.playlist.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!playlist) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const reset = await prisma.playlist.update({
    where: { id: playlist.id },
    data: { status: "active" },
  });

  const result = await pollPlaylist(user, reset);
  return NextResponse.json({ result });
}
