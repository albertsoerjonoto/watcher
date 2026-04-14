import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCodeForTokens, fetchMe } from "@/lib/spotify";
import { prisma } from "@/lib/db";
import { createSessionCookie } from "@/lib/session";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(error)}`, request.url),
    );
  }

  const jar = cookies();
  const verifier = jar.get("spw_pkce")?.value;
  const expectedState = jar.get("spw_state")?.value;
  jar.delete("spw_pkce");
  jar.delete("spw_state");

  if (!code || !verifier || !state || state !== expectedState) {
    return NextResponse.redirect(new URL("/?error=bad_state", request.url));
  }

  const tokens = await exchangeCodeForTokens({ code, codeVerifier: verifier });
  if (!tokens.refresh_token) {
    return NextResponse.redirect(new URL("/?error=no_refresh_token", request.url));
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000 - 30_000);

  // Temporary user-shaped object to call fetchMe with the fresh token.
  const tmpUser = {
    id: "pending",
    spotifyId: "pending",
    displayName: null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: expiresAt,
    createdAt: new Date(),
  } as unknown as Parameters<typeof fetchMe>[0];

  const { data: me } = await fetchMe(tmpUser);

  const user = await prisma.user.upsert({
    where: { spotifyId: me.id },
    update: {
      displayName: me.display_name ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt,
    },
    create: {
      spotifyId: me.id,
      displayName: me.display_name ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt,
    },
  });

  // Re-auth means any previously stuck playlists can be tried again.
  // Clear stale error logs and reactivate unavailable playlists so the
  // next poll (or the user re-clicking Add) can succeed cleanly.
  await prisma.playlist.updateMany({
    where: { userId: user.id, status: "unavailable" },
    data: { status: "active" },
  });
  await prisma.pollLog.deleteMany({
    where: {
      error: { not: null },
      playlist: { userId: user.id },
    },
  });

  const cookie = createSessionCookie(user.id);
  const res = NextResponse.redirect(new URL("/", request.url));
  res.cookies.set(cookie.name, cookie.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: cookie.maxAge,
  });
  return res;
}
