import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const data: {
    notifyMain?: boolean;
    notifyNew?: boolean;
    notifyOther?: boolean;
  } = {};
  if (typeof body.notifyMain === "boolean") data.notifyMain = body.notifyMain;
  if (typeof body.notifyNew === "boolean") data.notifyNew = body.notifyNew;
  if (typeof body.notifyOther === "boolean") data.notifyOther = body.notifyOther;
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no fields" }, { status: 400 });
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: { notifyMain: true, notifyNew: true, notifyOther: true },
  });
  return NextResponse.json(updated);
}
