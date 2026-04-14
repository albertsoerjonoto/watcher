import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export async function DELETE(
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
  await prisma.playlist.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const body = await request.json();
  const data: { notifyEnabled?: boolean } = {};
  if (typeof body.notifyEnabled === "boolean") {
    data.notifyEnabled = body.notifyEnabled;
  }
  const playlist = await prisma.playlist.findFirst({
    where: { id: params.id, userId: user.id },
  });
  if (!playlist) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const updated = await prisma.playlist.update({
    where: { id: params.id },
    data,
  });
  return NextResponse.json({ playlist: updated });
}
