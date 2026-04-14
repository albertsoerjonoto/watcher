import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { sendPushToUser } from "@/lib/push";

const SubSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const parsed = SubSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const { endpoint, keys } = parsed.data;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { p256dh: keys.p256dh, auth: keys.auth, userId: user.id },
    create: {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userId: user.id,
    },
  });
  return NextResponse.json({ ok: true });
}

// Send a test notification to verify the end-to-end path.
export async function PUT() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const result = await sendPushToUser(user.id, {
    title: "Spotify Watcher",
    body: "Test notification — if you see this, push is working.",
    url: "/",
  });
  return NextResponse.json({ ok: true, ...result });
}
