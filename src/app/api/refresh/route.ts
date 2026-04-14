// POST /api/refresh
//
// Polls every active playlist owned by the currently-signed-in user.
// This is the manual "pull new tracks now" endpoint that the dashboard
// invokes on mount — Vercel cron runs at most daily on the Hobby plan,
// so the webapp was showing stale data until the next cron fire. A
// logged-in user opening the dashboard is a strong signal they want
// fresh state.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { pollAllForUser } from "@/lib/poll";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const results = await pollAllForUser(user);
  return NextResponse.json({ ok: true, results });
}
