import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

// POST /api/playlists/reorder { a: id, b: id }
//
// Atomic swap of two playlists' sortOrder values. The dashboard's
// Move ↑ / Move ↓ buttons call this with the row and its neighbor.
//
// Doing this server-side keeps the math simple — the client doesn't
// need to know the existing sortOrder values, just the two ids to
// swap. We wrap the read+write in a transaction so a concurrent reorder
// can't corrupt the ordering.
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const body = (await request.json()) as { a?: string; b?: string };
  const { a, b } = body;
  if (!a || !b || a === b) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const rows = await prisma.playlist.findMany({
    where: { userId: user.id, id: { in: [a, b] } },
    select: { id: true, sortOrder: true },
  });
  if (rows.length !== 2) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const ra = rows.find((r) => r.id === a)!;
  const rb = rows.find((r) => r.id === b)!;
  await prisma.$transaction([
    prisma.playlist.update({
      where: { id: a },
      data: { sortOrder: rb.sortOrder },
    }),
    prisma.playlist.update({
      where: { id: b },
      data: { sortOrder: ra.sortOrder },
    }),
  ]);
  return NextResponse.json({ ok: true });
}
