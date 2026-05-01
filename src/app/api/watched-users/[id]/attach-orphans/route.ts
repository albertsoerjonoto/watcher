// POST /api/watched-users/:id/attach-orphans
//
// Bulk-attach orphan playlists (those with watchedUserId=null) to the
// given WatchedUser, by Spotify playlist ID list. No Spotify calls —
// pure DB write. Used to recover from cases where the normal sync
// can't reach the user-level Spotify endpoint (full third-party
// privacy lock) but the playlists themselves are tracked individually.
//
// The caller passes the playlist Spotify IDs they know belong to this
// watched user. We verify each playlist exists in the caller's account
// and isn't already attached, then set watchedUserId in one update.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  spotifyIds: z.array(z.string().min(1)).min(1).max(500),
});

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const body = Body.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: "invalid", details: body.error.message }, { status: 400 });
  }

  const watchedUser = await prisma.watchedUser.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!watchedUser) {
    return NextResponse.json({ error: "watched user not found" }, { status: 404 });
  }

  // Set watchedUserId for any of the given playlists owned by this user
  // that are currently orphan. updateMany returns count.
  const result = await prisma.playlist.updateMany({
    where: {
      userId: user.id,
      spotifyId: { in: body.data.spotifyIds },
      watchedUserId: null,
    },
    data: { watchedUserId: watchedUser.id },
  });

  // Also count how many of the requested IDs are now attached (any
  // attachment, not just from this call).
  const linked = await prisma.playlist.count({
    where: {
      userId: user.id,
      spotifyId: { in: body.data.spotifyIds },
      watchedUserId: watchedUser.id,
    },
  });

  return NextResponse.json({
    attached: result.count,
    nowLinked: linked,
    requested: body.data.spotifyIds.length,
  });
}
