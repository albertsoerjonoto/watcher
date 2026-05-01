// DELETE /api/watched-users/:id
//
// Stops watching a Spotify user. By default we DETACH their playlists
// (set watchedUserId = null, demote section to "other") rather than
// delete them, so the user's curated history isn't silently lost. The
// schema's Playlist.watchedUser FK is onDelete: Restrict — we'd error
// out trying to delete the WatchedUser otherwise, which is the point.
//
// Pass ?cascade=true to also delete the playlists. The UI must surface
// an explicit confirmation for that path; we don't want a stray click
// to wipe months of track history.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const watchedUser = await prisma.watchedUser.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!watchedUser) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const cascade = url.searchParams.get("cascade") === "true";

  if (cascade) {
    // Delete the playlists first (Track rows cascade-delete via the
    // existing Playlist→Track relation). Then delete the WatchedUser.
    await prisma.playlist.deleteMany({
      where: { userId: user.id, watchedUserId: watchedUser.id },
    });
  } else {
    // Detach: null out watchedUserId and demote any Main/New rows to
    // Other so they don't keep eating notification budget. Status
    // and tracks are preserved.
    await prisma.playlist.updateMany({
      where: { userId: user.id, watchedUserId: watchedUser.id },
      data: { watchedUserId: null, section: "other" },
    });
  }

  await prisma.watchedUser.delete({ where: { id: watchedUser.id } });

  return NextResponse.json({ ok: true, cascaded: cascade });
}
