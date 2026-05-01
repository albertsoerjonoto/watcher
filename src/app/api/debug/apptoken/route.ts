// GET /api/debug/apptoken?userId=<spotify_user_id>
//
// Auth-gated diagnostic: tests the Tier 2 (Client Credentials) flow.
// Mints an app token via SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET, then
// calls /v1/users/{id}/playlists with it and reports status + a slice
// of the body so we can see what Spotify says.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getCooldownSeconds, spotifyFetch } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const url = new URL(request.url);
  const targetId = url.searchParams.get("userId") ?? "31uxjftzzhheqxma2ksjviugtume";

  const cooldown = await getCooldownSeconds();
  if (cooldown > 0) {
    return NextResponse.json({ skipped: "cooldown", cooldownSeconds: cooldown });
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "secret-unset", hasClientId: !!clientId, hasClientSecret: !!clientSecret });
  }

  // Step 1: mint app token
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let token: string | null = null;
  let tokenStep: { status: number; ok: boolean; bodyStart: string; tokenLen?: number };
  try {
    const tokRes = await spotifyFetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: "grant_type=client_credentials",
    });
    const txt = await tokRes.text();
    tokenStep = { status: tokRes.status, ok: tokRes.ok, bodyStart: txt.slice(0, 200) };
    if (tokRes.ok) {
      try {
        const j = JSON.parse(txt) as { access_token?: string };
        token = j.access_token ?? null;
        tokenStep.tokenLen = token?.length;
      } catch {}
    }
  } catch (e) {
    return NextResponse.json({ tokenError: e instanceof Error ? e.message : String(e) });
  }

  if (!token) {
    return NextResponse.json({ tokenStep, note: "token mint failed" });
  }

  // Step 2: call /v1/users/{id}/playlists with app token
  type CallResult = { status: number; ok: boolean; bodyLen: number; bodyStart: string };
  let userPlaylistsStep: CallResult | { error: string };
  try {
    const res = await spotifyFetch(
      `https://api.spotify.com/v1/users/${encodeURIComponent(targetId)}/playlists?limit=50&offset=0`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const txt = await res.text();
    userPlaylistsStep = {
      status: res.status,
      ok: res.ok,
      bodyLen: txt.length,
      bodyStart: txt.slice(0, 400),
    };
  } catch (e) {
    userPlaylistsStep = { error: e instanceof Error ? e.message : String(e) };
  }

  // Step 3: also try fetching the user profile via app token, as a sanity check
  let profileStep: CallResult | { error: string };
  try {
    const res = await spotifyFetch(
      `https://api.spotify.com/v1/users/${encodeURIComponent(targetId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const txt = await res.text();
    profileStep = {
      status: res.status,
      ok: res.ok,
      bodyLen: txt.length,
      bodyStart: txt.slice(0, 400),
    };
  } catch (e) {
    profileStep = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(
    { target: targetId, tokenStep, userPlaylistsStep, profileStep },
    { headers: { "Cache-Control": "no-store" } },
  );
}
