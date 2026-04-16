import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

// POST /api/playlists/reorder { a: id, b: id }
//
// Swap the display positions of playlist `a` and playlist `b`.
//
// Fast path (O(2) writes): if the two playlists have distinct sortOrder
// values, just swap them — no need to touch any other rows.
//
// Slow path (O(N) writes): if the two share the same sortOrder (legacy
// data from before sortOrder was assigned uniquely), fall back to
// renumbering ALL of the user's playlists with a fresh monotonic
// sequence. The 10× gap (0, 10, 20, ...) lets future single-row
// inserts (AddPlaylistForm uses max+1) slot in without another
// full renumber pass.
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const body = (await request.json()) as { a?: string; b?: string };
  const { a, b } = body;
  if (!a || !b || a === b) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // Read only the two playlists we care about.
  const [pa, pb] = await Promise.all([
    prisma.playlist.findFirst({
      where: { id: a, userId: user.id },
      select: { id: true, sortOrder: true },
    }),
    prisma.playlist.findFirst({
      where: { id: b, userId: user.id },
      select: { id: true, sortOrder: true },
    }),
  ]);
  if (!pa || !pb) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (pa.sortOrder !== pb.sortOrder) {
    // Fast path: distinct sortOrder — just swap the two values.
    await prisma.$transaction([
      prisma.playlist.update({
        where: { id: pa.id },
        data: { sortOrder: pb.sortOrder },
      }),
      prisma.playlist.update({
        where: { id: pb.id },
        data: { sortOrder: pa.sortOrder },
      }),
    ]);
  } else {
    // Slow path: sortOrder collision — renumber everyone.
    const all = await prisma.playlist.findMany({
      where: { userId: user.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const ids = all.map((p) => p.id);
    const ai = ids.indexOf(a);
    const bi = ids.indexOf(b);
    if (ai < 0 || bi < 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    [ids[ai], ids[bi]] = [ids[bi], ids[ai]];
    await prisma.$transaction(
      ids.map((id, idx) =>
        prisma.playlist.update({
          where: { id },
          data: { sortOrder: idx * 10 },
        }),
      ),
    );
  }

  return NextResponse.json({ ok: true });
}
