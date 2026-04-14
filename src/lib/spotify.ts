// Thin Spotify Web API client with token refresh + rate-limit handling.
//
// Only the surface we need for Phase 1:
//   - token exchange / refresh (PKCE)
//   - GET /me
//   - GET /playlists/{id}  (just to read snapshot_id + metadata cheaply)
//   - GET /playlists/{id}/tracks  (paginated)

import { prisma } from "./db";
import type { User } from "@prisma/client";
import type { TrackKeyed } from "./diff";

const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";

export class SpotifyError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string,
  ) {
    // Include a short body preview in the message so the reason shows up
    // in PollLog rows (which only persist `error: string`).
    const preview =
      typeof body === "string"
        ? body.slice(0, 300)
        : body
          ? JSON.stringify(body).slice(0, 300)
          : "";
    super(
      message ??
        `Spotify API error ${status}${preview ? `: ${preview}` : ""}`,
    );
  }
}

export interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
}

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
}): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI!,
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    code_verifier: params.codeVerifier,
  });
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new SpotifyError(res.status, await res.text(), "Token exchange failed");
  }
  return res.json();
}

async function refreshAccessToken(user: User): Promise<User> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: user.refreshToken,
    client_id: process.env.SPOTIFY_CLIENT_ID!,
  });
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new SpotifyError(res.status, await res.text(), "Token refresh failed");
  }
  const json = (await res.json()) as SpotifyTokenResponse;
  return prisma.user.update({
    where: { id: user.id },
    data: {
      accessToken: json.access_token,
      // Spotify may or may not rotate the refresh token.
      refreshToken: json.refresh_token ?? user.refreshToken,
      tokenExpiresAt: new Date(Date.now() + json.expires_in * 1000 - 30_000),
    },
  });
}

async function ensureFreshToken(user: User): Promise<User> {
  if (user.tokenExpiresAt.getTime() > Date.now() + 30_000) return user;
  return refreshAccessToken(user);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Authed GET against Spotify with refresh-token rotation and Retry-After
 * handling. Retries 429 and 5xx up to 3 times.
 */
export async function spotifyGet<T = unknown>(
  userIn: User,
  path: string,
): Promise<{ user: User; data: T }> {
  let user = await ensureFreshToken(userIn);
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    if (res.status === 401 && attempt === 1) {
      user = await refreshAccessToken(user);
      continue;
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "1");
      if (attempt > 4) throw new SpotifyError(429, await res.text());
      await sleep(Math.min(retry, 30) * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(500 * attempt);
      continue;
    }
    if (!res.ok) {
      throw new SpotifyError(res.status, await res.text());
    }
    return { user, data: (await res.json()) as T };
  }
}

// --- Types we actually read from Spotify ---
export interface SpotifyPlaylistMeta {
  id: string;
  name: string;
  snapshot_id: string;
  owner: { id: string; display_name?: string };
}

interface SpotifyPlaylistTrackItem {
  added_at: string;
  added_by: { id: string } | null;
  is_local: boolean;
  track: {
    id: string | null;
    name: string;
    duration_ms: number;
    album?: { name: string };
    artists: { name: string }[];
  } | null;
}

interface SpotifyTracksPage {
  items: SpotifyPlaylistTrackItem[];
  next: string | null;
  total: number;
}

export async function fetchPlaylistMeta(user: User, playlistId: string) {
  return spotifyGet<SpotifyPlaylistMeta>(
    user,
    `/playlists/${playlistId}?fields=id,name,snapshot_id,owner(id,display_name)`,
  );
}

/**
 * Paginate through every track in a playlist, normalizing into our
 * TrackKeyed shape. Local tracks and null tracks (removed songs) are skipped.
 */
export async function fetchAllPlaylistTracks(
  userIn: User,
  playlistId: string,
): Promise<{ user: User; tracks: TrackKeyed[] }> {
  let user = userIn;
  const out: TrackKeyed[] = [];
  let url: string | null =
    `/playlists/${playlistId}/tracks?limit=100&fields=next,total,items(added_at,added_by(id),is_local,track(id,name,duration_ms,album(name),artists(name)))`;
  while (url !== null) {
    const page: { user: User; data: SpotifyTracksPage } =
      await spotifyGet<SpotifyTracksPage>(user, url);
    user = page.user;
    const data: SpotifyTracksPage = page.data;
    for (const it of data.items) {
      if (it.is_local || !it.track || !it.track.id) continue;
      out.push({
        spotifyTrackId: it.track.id,
        title: it.track.name,
        artists: it.track.artists.map((a) => a.name),
        album: it.track.album?.name ?? null,
        durationMs: it.track.duration_ms,
        addedAt: it.added_at,
        addedBySpotifyId: it.added_by?.id ?? null,
      });
    }
    if (!data.next) break;
    // next is a full URL; strip the API prefix so spotifyGet can reuse.
    url = data.next.replace(API, "");
  }
  return { user, tracks: out };
}

export async function fetchMe(user: User) {
  return spotifyGet<{ id: string; display_name?: string }>(user, "/me");
}

export function parsePlaylistId(input: string): string | null {
  const trimmed = input.trim();
  // Accept bare IDs, spotify: URIs, and open.spotify.com URLs.
  if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return trimmed;
  const uriMatch = trimmed.match(/^spotify:playlist:([A-Za-z0-9]+)/);
  if (uriMatch) return uriMatch[1];
  const urlMatch = trimmed.match(
    /open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]+)/,
  );
  if (urlMatch) return urlMatch[1];
  return null;
}
