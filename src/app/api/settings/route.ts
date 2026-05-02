// GET /api/settings
//
// Returns everything the Settings page client needs in a single round
// trip: user notify-by-section flags, push subscription count, watched
// users, playlists, and per-playlist week counts. Pure DB reads — no
// Spotify calls.
//
// Mirrors /api/dashboard and /api/feed. The SWR cache key is
// SETTINGS_KEY from src/components/settings-keys.ts.

import { NextResponse } from "next/server";
import { readSessionUserId } from "@/lib/session";
import { loadSettingsData } from "@/lib/settings-data";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = readSessionUserId();
  if (!userId) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const data = await loadSettingsData(userId);
  if (!data) return NextResponse.json({ error: "unauth" }, { status: 401 });
  return NextResponse.json(data);
}
