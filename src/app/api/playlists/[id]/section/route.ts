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
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { MAX_MAIN_PER_WATCHED_USER } from "@/lib/stale";

export const dynamic = "force-dynamic";

// Sentinel thrown inside the transaction when the cap check fails. Caught
// at the top level and converted to a 409 — keeps the cap-rejection path
// distinct from genuine errors (DB outage, serialization conflict).
class MainCapError extends Error {
  constructor(public mainCount: number) {
    super("main_cap_reached");
  }
}

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
  //
  // The count + update is wrapped in a Serializable transaction so two
  // concurrent promotions can't both pass the check and leave Main
  // overfull. PostgreSQL throws P2034 ("transaction failed due to a
  // write conflict or a deadlock") on the loser of the race; we map
  // that to the same 409 the user would see if they hit the cap
  // single-threaded — semantically it IS a cap-reached, just a racy
  // one. Without this guard the cap is enforceable only as a UX
  // guideline, not an invariant.
  try {
    await prisma.$transaction(
      async (tx) => {
        if (target === "main") {
          const mainCount = await tx.playlist.count({
            where: {
              userId: user.id,
              watchedUserId: playlist.watchedUserId,
              section: "main",
              // Don't double-count this row if it was already Main
              // (we no-op'd above, but be defensive in case section
              // semantics change).
              NOT: { id: playlist.id },
            },
          });
          if (mainCount >= MAX_MAIN_PER_WATCHED_USER) {
            throw new MainCapError(mainCount);
          }
        }
        await tx.playlist.update({
          where: { id: playlist.id },
          data: { section: target },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof MainCapError) {
      return NextResponse.json(
        {
          error: "main_cap_reached",
          mainCount: e.mainCount,
          cap: MAX_MAIN_PER_WATCHED_USER,
        },
        { status: 409 },
      );
    }
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2034"
    ) {
      // Serialization failure: another transaction promoting to Main
      // committed between our count and our update. Treat as cap-
      // reached so the client surfaces the same message.
      return NextResponse.json(
        {
          error: "main_cap_reached",
          mainCount: MAX_MAIN_PER_WATCHED_USER,
          cap: MAX_MAIN_PER_WATCHED_USER,
        },
        { status: 409 },
      );
    }
    throw e;
  }

  return NextResponse.json({ ok: true, section: target });
}
