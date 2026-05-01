// GET  /api/watched-users — list this user's WatchedUser rows
// POST /api/watched-users — add a new WatchedUser by Spotify URL/URI/id
//
// POST behavior:
//   1. Cooldown gate (DB-only, zero Spotify calls).
//   2. Parse the input. parseUserId accepts bare ids, spotify:user URIs,
//      and open.spotify.com/user URLs.
//   3. Refuse if a WatchedUser for this (auth-user, spotifyId) already
//      exists — caller should use POST /api/watched-users/:id/sync to
//      re-fetch instead.
//   4. Call syncWatchedUser(). Profile + paginated playlists fetch (up
//      to 5 Spotify calls). All playlists land in section="other" with
//      no notifications because lastSyncedAt is still null on entry.
//   5. Return the new row's id, displayName, and counts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { parseUserId } from "@/lib/spotify";
import { getCooldownSeconds } from "@/lib/rate-limit";
import { syncWatchedUser } from "@/lib/watched-user-sync";
import { SpotifyError } from "@/lib/spotify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const watchedUsers = await prisma.watchedUser.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { playlists: true } },
    },
  });

  return NextResponse.json({ watchedUsers });
}

const AddSchema = z.object({
  url: z.string().min(1),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const cooldown = await getCooldownSeconds();
  if (cooldown > 0) {
    return NextResponse.json({
      ok: true,
      skipped: "cooldown",
      cooldownSeconds: cooldown,
    });
  }

  const body = AddSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const spotifyId = parseUserId(body.data.url);
  if (!spotifyId) {
    return NextResponse.json(
      { error: "could not parse Spotify user id" },
      { status: 400 },
    );
  }

  const existing = await prisma.watchedUser.findUnique({
    where: { userId_spotifyId: { userId: user.id, spotifyId } },
  });
  if (existing) {
    return NextResponse.json(
      {
        error: "already watching this user",
        watchedUserId: existing.id,
      },
      { status: 409 },
    );
  }

  try {
    const result = await syncWatchedUser(user, spotifyId);
    return NextResponse.json({
      ok: true,
      watchedUser: {
        id: result.watchedUser.id,
        spotifyId: result.watchedUser.spotifyId,
        displayName: result.watchedUser.displayName,
        imageUrl: result.watchedUser.imageUrl,
      },
      added: result.added,
      total: result.total,
      truncated: result.truncated,
    });
  } catch (e) {
    // Surface the Spotify status code so the client can render the
    // most helpful message. 404 → user doesn't exist; 403 → user's
    // privacy settings or app permissions block access; 429 → cooldown
    // (the inner cooldown gate should have caught this already, but
    // belt-and-suspenders); everything else → 502 upstream.
    if (e instanceof SpotifyError) {
      console.error(
        `[POST /api/watched-users] Spotify ${e.status}:`,
        e.message,
      );
      const status =
        e.status === 404 || e.status === 403 || e.status === 429
          ? e.status
          : 502;
      return NextResponse.json(
        { error: e.message, status: e.status },
        { status },
      );
    }
    console.error("[POST /api/watched-users] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
