// PATCH /api/playlists/:id/section
//
// Body: { section: "main" | "new" | "other" }
//
// Enforces MAX_MAIN_PER_WATCHED_USER per (auth-user, watched-user) when
// promoting to "main". A playlist with watchedUserId = null still has a
// Main count "scope" — it's the bucket of unattached playlists, treated
// as its own group. We count those separately so that orphan stubs
// (added by URL but not yet polled) don't compete with a real
// watched user's quota.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { MAX_MAIN_PER_WATCHED_USER } from "@/lib/stale";

export const dynamic = "force-dynamic";

const Body = z.object({
  section: z.enum(["main", "new", "other"]),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid section" }, { status: 400 });
  }
  const target = parsed.data.section;

  const playlist = await prisma.playlist.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!playlist) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // No-op: same section. Avoid an unnecessary UPDATE.
  if (playlist.section === target) {
    return NextResponse.json({ ok: true, section: target, mainCount: null });
  }

  // Enforce Main cap on promotion. The cap is per (userId, watchedUserId)
  // — we count main rows scoped to the same watchedUserId (or null bucket).
  if (target === "main") {
    const mainCount = await prisma.playlist.count({
      where: {
        userId: user.id,
        watchedUserId: playlist.watchedUserId, // null matches null in Prisma
        section: "main",
        // Don't double-count this row if it was already Main (we no-op'd
        // above, but be defensive in case section semantics change).
        NOT: { id: playlist.id },
      },
    });
    if (mainCount >= MAX_MAIN_PER_WATCHED_USER) {
      return NextResponse.json(
        {
          error: "main_cap_reached",
          mainCount,
          cap: MAX_MAIN_PER_WATCHED_USER,
        },
        { status: 409 },
      );
    }
  }

  await prisma.playlist.update({
    where: { id: playlist.id },
    data: { section: target },
  });

  return NextResponse.json({ ok: true, section: target });
}
