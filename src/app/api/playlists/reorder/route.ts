import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

// POST /api/playlists/reorder { a: id, b: id }
//
// Move row `a` to swap positions with row `b` in the user's display
// order, then renumber sortOrder for ALL of the user's playlists so
// the new ordering is fully canonical.
//
// Why renumber-everyone instead of "just swap the two sortOrder
// values" (the previous implementation): old playlists added before
// sortOrder was assigned uniquely all share sortOrder=0, so swapping
// two zeros was a visible no-op and the buttons looked broken on the
// dashboard. Renumbering with a fresh monotonic sequence is robust
// against collisions, against gaps, and against any future drift.
//
// We multiply by 10 (0, 10, 20, ...) so future single-row inserts
// (AddPlaylistForm uses max+1) still slot in cleanly without needing
// another full renumber pass.
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const body = (await request.json()) as { a?: string; b?: string };
  const { a, b } = body;
  if (!a || !b || a === b) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // Read the full ordered list once. We need it both to validate that
  // a and b belong to this user and to compute the renumber sequence.
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

  // Swap positions in the array, then renumber everyone.
  [ids[ai], ids[bi]] = [ids[bi], ids[ai]];

  await prisma.$transaction(
    ids.map((id, idx) =>
      prisma.playlist.update({
        where: { id },
        data: { sortOrder: idx * 10 },
      }),
    ),
  );
  return NextResponse.json({ ok: true });
}
