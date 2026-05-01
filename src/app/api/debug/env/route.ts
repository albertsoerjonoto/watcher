// GET /api/debug/env
//
// Auth-gated diagnostic: reports which optional environment variables
// are configured. Returns booleans only — never the values themselves.
// Used to confirm whether SPOTIFY_CLIENT_SECRET is wired up so the
// app-token fallback in fetchUserPublicPlaylists / fetchAllPlaylistTracks
// can succeed for users with restrictive privacy settings.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getCooldownSeconds } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const cooldownSeconds = await getCooldownSeconds();

  return NextResponse.json(
    {
      env: {
        SPOTIFY_CLIENT_ID: Boolean(process.env.SPOTIFY_CLIENT_ID),
        SPOTIFY_CLIENT_SECRET: Boolean(process.env.SPOTIFY_CLIENT_SECRET),
        SPOTIFY_REDIRECT_URI: Boolean(process.env.SPOTIFY_REDIRECT_URI),
        DATABASE_URL: Boolean(process.env.DATABASE_URL),
        SESSION_SECRET: Boolean(process.env.SESSION_SECRET),
        CRON_SECRET: Boolean(process.env.CRON_SECRET),
        VAPID_PUBLIC_KEY: Boolean(process.env.VAPID_PUBLIC_KEY),
        VAPID_PRIVATE_KEY: Boolean(process.env.VAPID_PRIVATE_KEY),
      },
      cooldownSeconds,
      verdict:
        process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET
          ? "App-token fallback IS configured. Watched users with restrictive privacy settings should be reachable via Client Credentials."
          : "App-token fallback is NOT configured. Add SPOTIFY_CLIENT_SECRET to your Vercel env to unblock users whose /users/{id}/playlists 403s on the user OAuth token. Restart/redeploy after adding.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
