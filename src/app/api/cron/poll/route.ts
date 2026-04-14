// Cron endpoint. Call every 10-15 minutes with:
//   Authorization: Bearer $CRON_SECRET
//
// Idempotent: safe to retry. Snapshot check makes repeats cheap.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { pollAllForUser } from "@/lib/poll";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const fromVercel = request.headers.get("x-vercel-cron"); // Vercel Cron
  if (fromVercel) return true;
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const users = await prisma.user.findMany();
  const out: Record<string, unknown> = {};
  for (const u of users) {
    out[u.spotifyId] = await pollAllForUser(u);
  }
  return NextResponse.json({ ok: true, users: out });
}

// Also accept POST for flexibility with some cron providers.
export const POST = GET;
