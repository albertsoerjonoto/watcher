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
        ? body.slice(0, 800)
        : body
          ? JSON.stringify(body).slice(0, 800)
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

// The playlist object's tracks may arrive in one of three shapes
// depending on the account / API version:
//
//   1. Standard: { tracks: { items, next, total, ... } }
//   2. Fully flattened: { items: [...], next?, total? } where items is
//      a direct array at the top level.
//   3. Renamed paging: { items: { items: [...], next, total, ... } }
//      where the entire paging wrapper is at the top level under `items`
//      instead of under `tracks`. This is what Spotify actually returns
//      for the affected accounts — it looks like `tracks` was renamed
//      to `items`.
//
// This helper normalizes all three into a SpotifyTracksPage.
function tryPaging(obj: unknown): SpotifyTracksPage | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.items)) return null;
  return {
    items: o.items as SpotifyPlaylistTrackItem[],
    next: (o.next as string | null | undefined) ?? null,
    total: (o.total as number | undefined) ?? (o.items as unknown[]).length,
  };
}

export function extractTracksPage(
  data: unknown,
): SpotifyTracksPage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  // Shape 1: nested under `tracks`
  const nested = tryPaging(d.tracks);
  if (nested) return nested;

  // Shape 2: direct array at `items`
  if (Array.isArray(d.items)) {
    return {
      items: d.items as SpotifyPlaylistTrackItem[],
      next: (d.next as string | null | undefined) ?? null,
      total: (d.total as number | undefined) ?? (d.items as unknown[]).length,
    };
  }

  // Shape 3: paging wrapper at `items` (tracks renamed to items)
  const renamed = tryPaging(d.items);
  if (renamed) return renamed;

  return null;
}

export async function fetchPlaylistMeta(user: User, playlistId: string) {
  return spotifyGet<SpotifyPlaylistMeta>(
    user,
    `/playlists/${playlistId}?fields=id,name,snapshot_id,owner(id,display_name)`,
  );
}

function normalizeItems(
  items: SpotifyPlaylistTrackItem[],
  out: TrackKeyed[],
) {
  for (const it of items) {
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
}

/**
 * Paginate through every track in a playlist, normalizing into our
 * TrackKeyed shape. Local tracks and null tracks (removed songs) are skipped.
 *
 * Implementation note: the dedicated `/playlists/{id}/tracks` endpoint
 * returns 403 Forbidden for some Spotify accounts (confirmed via
 * /api/debug/probe — meta works, `/me/playlists` works, but every variant
 * of /tracks 403s with no helpful message, including with `market=`,
 * without `fields=`, and with minimal fields).
 *
 * Fetching via `/playlists/{id}?fields=tracks(...)` also doesn't work:
 * Spotify returns 200 but silently strips the `tracks` field, returning
 * just the whitelisted scalars.
 *
 * The approach that works: fetch `/playlists/{id}` with NO fields filter
 * at all. The standard playlist response embeds the first 100 tracks
 * inline in `.tracks.items`, and since we're not trying to filter that
 * subtree Spotify doesn't strip it. For playlists with >100 tracks we
 * paginate via `.tracks.next` which points back at the dedicated /tracks
 * endpoint — if that 403s we return what we got rather than failing.
 */
export async function fetchAllPlaylistTracks(
  userIn: User,
  playlistId: string,
): Promise<{ user: User; tracks: TrackKeyed[] }> {
  const first = await spotifyGet<unknown>(
    userIn,
    `/playlists/${playlistId}`,
  );

  let user = first.user;
  const initialPage = extractTracksPage(first.data);
  if (!initialPage) {
    // Maximally informative error: top-level keys, plus type and
    // nested-keys of both `tracks` and `items` if present. This tells
    // me exactly what shape Spotify returned so no more guessing.
    const d =
      first.data && typeof first.data === "object"
        ? (first.data as Record<string, unknown>)
        : {};
    const keys = Object.keys(d).join(",");
    const describe = (k: string): string => {
      const v = d[k];
      if (v === undefined) return `${k}=absent`;
      if (v === null) return `${k}=null`;
      if (Array.isArray(v)) return `${k}=array[${v.length}]`;
      if (typeof v === "object") {
        const inner = Object.keys(v as Record<string, unknown>).join(",");
        return `${k}=object{${inner}}`;
      }
      return `${k}=${typeof v}`;
    };
    throw new SpotifyError(
      0,
      first.data,
      `no tracks field. top=[${keys}] ${describe("tracks")} ${describe("items")}`,
    );
  }

  const out: TrackKeyed[] = [];
  let page: SpotifyTracksPage = initialPage;
  normalizeItems(page.items, out);

  // Pagination. The first page usually holds up to 100 items; anything
  // beyond that requires following page.next. That URL typically points
  // at the dedicated /playlists/{id}/tracks endpoint, which 403s for
  // some accounts — if so we return what we already have rather than
  // failing the entire poll.
  //
  // If there's no explicit `next` but we got exactly 100 items back,
  // there *might* be more — try the /tracks endpoint with offset=100 as
  // a best-effort fallback and silently stop on 403.
  while (page.next) {
    const nextRel = page.next.replace(API, "");
    try {
      const resp = await spotifyGet<unknown>(user, nextRel);
      user = resp.user;
      const nextPage = extractTracksPage(resp.data);
      if (!nextPage) break;
      page = nextPage;
      normalizeItems(page.items, out);
    } catch (err) {
      if (err instanceof SpotifyError && err.status === 403) break;
      throw err;
    }
  }

  if (!page.next && out.length > 0 && out.length % 100 === 0) {
    // Best-effort continuation for the flattened shape where `next`
    // isn't provided but there might still be more tracks.
    let offset = out.length;
    while (true) {
      try {
        const resp = await spotifyGet<unknown>(
          user,
          `/playlists/${playlistId}/tracks?offset=${offset}&limit=100`,
        );
        user = resp.user;
        const extra = extractTracksPage(resp.data);
        if (!extra || extra.items.length === 0) break;
        normalizeItems(extra.items, out);
        if (extra.items.length < 100) break;
        offset += extra.items.length;
      } catch (err) {
        if (err instanceof SpotifyError && err.status === 403) break;
        throw err;
      }
    }
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
