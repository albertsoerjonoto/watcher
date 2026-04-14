import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  generateCodeVerifier,
  codeChallengeFromVerifier,
  randomState,
} from "@/lib/pkce";
import { SESSION_COOKIE_NAME } from "@/lib/session";

const SCOPES = ["playlist-read-private", "playlist-read-collaborative"];

export async function GET() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "SPOTIFY_CLIENT_ID / SPOTIFY_REDIRECT_URI not configured" },
      { status: 500 },
    );
  }

  const verifier = generateCodeVerifier();
  const challenge = codeChallengeFromVerifier(verifier);
  const state = randomState();

  const jar = cookies();
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  jar.set("spw_pkce", verifier, opts);
  jar.set("spw_state", state, opts);
  // Always start a fresh session — if an old cookie pointed at a user
  // whose refresh token is dead, we want to overwrite it after callback
  // rather than keep serving errors. Deleting here is safe: the callback
  // writes a new cookie on success.
  jar.delete(SESSION_COOKIE_NAME);

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString());
}
