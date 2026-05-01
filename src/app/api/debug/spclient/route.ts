// GET /api/debug/spclient?userId=<spotify_user_id>
//
// Auth-gated diagnostic: calls spclient.wg.spotify.com/user-profile-view/v3/profile/{id}
// with the current user's OAuth token and reports status + body preview.
// Used to debug why the Tier 3 spclient fallback fails for some users.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getCooldownSeconds, spotifyFetch } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";

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

  // Refresh token if needed.
  let acc = user;
  if (acc.tokenExpiresAt.getTime() <= Date.now() + 30_000) {
    // simulate ensureFreshToken without importing it (the function is private)
    return NextResponse.json({ skipped: "token-expired", note: "user needs to re-login" });
  }

  // Try with Accept: application/json
  const u = `https://spclient.wg.spotify.com/user-profile-view/v3/profile/${encodeURIComponent(targetId)}?playlist_limit=200&market=from_token`;

  type Result = { status: number; ok: boolean; ct: string | null; bodyLen: number; bodyStart: string };
  let withJsonAccept: Result | { error: string };
  try {
    const res = await spotifyFetch(u, {
      headers: {
        Authorization: `Bearer ${acc.accessToken}`,
        Accept: "application/json",
        "App-Platform": "WebPlayer",
      },
    });
    const txt = await res.text();
    withJsonAccept = {
      status: res.status,
      ok: res.ok,
      ct: res.headers.get("content-type"),
      bodyLen: txt.length,
      bodyStart: txt.slice(0, 300),
    };
  } catch (e) {
    withJsonAccept = { error: e instanceof Error ? e.message : String(e) };
  }

  // Check the user's spotify token expiry / scope
  const userRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { tokenExpiresAt: true, spotifyId: true },
  });

  return NextResponse.json(
    {
      target: targetId,
      tokenExpiresAt: userRow?.tokenExpiresAt,
      withJsonAccept,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
