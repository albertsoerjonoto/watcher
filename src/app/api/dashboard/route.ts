// GET /api/dashboard
//
// Returns all data the dashboard client component needs in a single
// round-trip: watched users with their section counts, playlists (with
// track counts), recent tracks per playlist, week counts, and latest
// poll errors. Designed to be the SWR cache key so page transitions are
// instant (stale-while-revalidate).
//
// No Spotify calls — pure DB reads. The shape is defined by
// loadDashboardData() in @/lib/dashboard-data and is shared with the
// SSR fallback in src/app/page.tsx.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { loadDashboardData } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const data = await loadDashboardData(user);
  return NextResponse.json(data);
}
