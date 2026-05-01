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
  const res = await spotifyFetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new SpotifyError(res.status, await res.text(), "Token exchange failed");
  }
  return res.json<SpotifyTokenResponse>();
}

async function refreshAccessToken(user: User): Promise<User> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: user.refreshToken,
    client_id: process.env.SPOTIFY_CLIENT_ID!,
  });
  const res = await spotifyFetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new SpotifyError(res.status, await res.text(), "Token refresh failed");
  }
  const json = await res.json<SpotifyTokenResponse>();
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

// Rate-limit prevention lives in `./rate-limit` — see the post-mortem
// there. Every outgoing Spotify request MUST use spotifyFetch() which
// gates (cooldown + budget + interval), records the call, and handles
// 429 automatically. No raw fetch() to any Spotify host is permitted
// anywhere in this file.
import { spotifyFetch, SpotifyRateLimitError } from "./rate-limit";

/**
 * Authed GET against Spotify with refresh-token rotation and 5xx retry.
 * Rate-limit gating, call recording, and 429 handling are all inside
 * spotifyFetch — this function just adds auth and token refresh.
 */
export async function spotifyGet<T = unknown>(
  userIn: User,
  path: string,
): Promise<{ user: User; data: T }> {
  try {
    let user = await ensureFreshToken(userIn);
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      const res = await spotifyFetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      if (res.status === 401 && attempt === 1) {
        user = await refreshAccessToken(user);
        continue;
      }
      // 429 is handled by spotifyFetch (throws SpotifyRateLimitError).
      if (res.status >= 500 && attempt < 3) {
        await sleep(500 * attempt);
        continue;
      }
      if (!res.ok) {
        throw new SpotifyError(res.status, await res.text());
      }
      return { user, data: await res.json<T>() };
    }
  } catch (e) {
    // Convert SpotifyRateLimitError to SpotifyError(429) so all callers
    // see the same error shape regardless of whether the block came from
    // the gate or a real 429 response.
    if (e instanceof SpotifyRateLimitError) {
      throw new SpotifyError(429, "cooldown", e.message);
    }
    throw e;
  }
}

// --- Types we actually read from Spotify ---
export interface SpotifyImage {
  url: string;
  width?: number | null;
  height?: number | null;
}
export interface SpotifyPlaylistMeta {
  id: string;
  name: string;
  snapshot_id: string;
  owner: { id: string; display_name?: string };
  images?: SpotifyImage[];
}

// A single item returned from Spotify inside a playlist's tracks paging.
//
// Spotify has quietly rotated the field names on this object multiple
// times. The track payload can appear under either `track` (classic) or
// `item` (current, observed April 2026 — coincident with the outer
// `tracks` wrapper being renamed to `items`). We accept both.
interface SpotifyTrackPayload {
  id: string | null;
  name: string;
  duration_ms: number;
  album?: { name: string; images?: SpotifyImage[] };
  artists: { name: string }[];
}
interface SpotifyPlaylistTrackItem {
  added_at: string;
  added_by: { id: string } | null;
  is_local: boolean;
  track?: SpotifyTrackPayload | null;
  item?: SpotifyTrackPayload | null;
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
    `/playlists/${playlistId}?fields=id,name,snapshot_id,owner(id,display_name),images`,
  );
}

function normalizeItems(
  items: SpotifyPlaylistTrackItem[],
  out: TrackKeyed[],
) {
  for (const it of items) {
    if (it.is_local) continue;
    // Spotify renamed `track` to `item` on playlist-item objects — accept
    // whichever field carries the track payload.
    const payload: SpotifyTrackPayload | null | undefined = it.track ?? it.item;
    if (!payload || !payload.id) continue;
    // Defensive: skip tracks with no name (malformed API response).
    if (!payload.name) continue;
    out.push({
      spotifyTrackId: payload.id,
      title: payload.name,
      artists: (payload.artists ?? []).map((a) => a.name),
      album: payload.album?.name ?? null,
      albumImageUrl: payload.album?.images?.[0]?.url ?? null,
      durationMs: payload.duration_ms,
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
  const out: TrackKeyed[] = [];
  const initialPage = extractTracksPage(first.data);

  // Infer total from the playlist metadata's `tracks.total` scalar — Spotify
  // sometimes returns the latter even when it omits the paging wrapper
  // entirely. Returns null if the total is genuinely unknown (distinct from 0).
  function inferTotal(d: unknown): number | null {
    if (!d || typeof d !== "object") return null;
    const o = d as Record<string, unknown>;
    const t = o.tracks;
    if (t && typeof t === "object" && "total" in (t as Record<string, unknown>)) {
      const n = (t as Record<string, unknown>).total;
      if (typeof n === "number") return n;
    }
    return null;
  }

  let total = 0;
  let page: SpotifyTracksPage | null = initialPage;
  if (page) {
    normalizeItems(page.items, out);
    total = page.total;
  } else {
    // Spotify returned a playlist object with no embedded tracks — not even
    // an empty `items` array. Fall back to the dedicated track-listing
    // endpoints. We try `/items` (current) then `/tracks` (legacy).
    //
    // We need to distinguish two cases:
    //   (a) The playlist is genuinely empty (total=0 via metadata).
    //   (b) Spotify is blocking track access for this playlist entirely
    //       — every endpoint 403s and the main call silently strips
    //       `tracks`. This happens for some 3rd-party playlists and there
    //       is no way around it with a user token + our scopes. Surface
    //       this as a loud error so the user knows the import failed.
    const metaTotal = inferTotal(first.data); // null = unknown, 0 = empty, >0 = has tracks
    const endpoints = [
      `/playlists/${playlistId}/items?limit=100`,
      `/playlists/${playlistId}/tracks?limit=100`,
    ];
    const fallbackStatuses: number[] = [];
    for (const ep of endpoints) {
      try {
        const resp = await spotifyGet<unknown>(user, ep);
        user = resp.user;
        const p = extractTracksPage(resp.data);
        if (!p) continue;
        page = p;
        normalizeItems(p.items, out);
        total = p.total || metaTotal || p.items.length;
        break;
      } catch (err) {
        if (err instanceof SpotifyError) {
          fallbackStatuses.push(err.status);
          if (err.status === 403 || err.status === 404) continue;
        }
        throw err;
      }
    }

    if (!page) {
      // All user-token Web API fallbacks failed. If metadata explicitly
      // said total=0, this is a legitimate empty playlist.
      if (metaTotal === 0) {
        return { user, tracks: out };
      }
      // Tier 1 fallback: Pathfinder GraphQL. This is what the desktop
      // web player uses, and it supports offset pagination across the
      // full playlist (not capped at 100 like the embed). Returns
      // everything — real addedAt, addedBy, album art, the works.
      const pathfinderTracks = await fetchAllTracksViaPathfinder(playlistId);
      if (pathfinderTracks && pathfinderTracks.length > 0) {
        return { user, tracks: pathfinderTracks };
      }
      // Tier 2 fallback: Client Credentials (app token). Separate quota
      // pool from the user token and not subject to user-scope
      // restrictions. Only works if SPOTIFY_CLIENT_SECRET is set.
      const appTracks = await fetchAllTracksWithAppToken(playlistId);
      if (appTracks && appTracks.length > 0) {
        return { user, tracks: appTracks };
      }
      // Tier 3 fallback: scrape the public embed page's __NEXT_DATA__.
      // Caps at ~100 tracks and has no real `addedAt` — we enrich album
      // metadata via /v1/tracks?ids= (catalog endpoint works on user
      // tokens even when playlist-track endpoints don't) and synthesize
      // a stable addedAt = epoch so diffs stay idempotent.
      const embedResult = await fetchEmbedTracks(user, playlistId);
      user = embedResult.user;
      if (embedResult.tracks.length === 0) {
        const statusStr = fallbackStatuses.length
          ? fallbackStatuses.join(",")
          : "none";
        throw new SpotifyError(
          403,
          first.data,
          `Spotify blocked track access for this playlist. Web API /items + /tracks returned ${statusStr}, Client Credentials fallback ${process.env.SPOTIFY_CLIENT_SECRET ? "also failed" : "unavailable (SPOTIFY_CLIENT_SECRET not set)"}, and the embed fallback returned no tracks either.`,
        );
      }
      return { user, tracks: embedResult.tracks };
    }
    total = Math.max(total, metaTotal ?? 0);
  }

  // Pagination. Spotify's behavior here is flaky — the dedicated
  // `/playlists/{id}/tracks` endpoint returns 403 on some accounts, and
  // the replacement `/playlists/{id}/items` endpoint sometimes returns a
  // `next` URL that still points at offset=0 (which would infinite-loop
  // if naively followed). We guard against both.
  //
  // Loop termination conditions (any of):
  //   - no `next` url
  //   - we've collected >= total items
  //   - the next page has zero items
  //   - we see the same offset twice (bogus `next` pointer)
  //   - hard cap at 100 iterations so a pathological response can never
  //     hang the poller
  const seenOffsets = new Set<number>();

  function parseOffset(url: string): number | null {
    try {
      const m = /[?&]offset=(\d+)/.exec(url);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  let guard = 0;
  while (page.next && out.length < total && guard < 100) {
    guard++;
    const offset = parseOffset(page.next);
    if (offset !== null) {
      if (seenOffsets.has(offset)) break;
      seenOffsets.add(offset);
    }
    // Strip the API prefix so spotifyGet can prepend it again.
    const nextRel = page.next.replace(API, "");
    try {
      const resp = await spotifyGet<unknown>(user, nextRel);
      user = resp.user;
      const nextPage = extractTracksPage(resp.data);
      if (!nextPage || nextPage.items.length === 0) break;
      page = nextPage;
      normalizeItems(page.items, out);
    } catch (err) {
      if (err instanceof SpotifyError && (err.status === 403 || err.status === 404)) break;
      throw err;
    }
  }

  // Best-effort offset-based fallback for the case where `next` was
  // missing but the page was exactly full. Try the `/items` endpoint
  // first (current), then `/tracks` (legacy). Stop on any 403/404/empty.
  if (out.length < total && out.length > 0 && out.length % 100 === 0) {
    let offset = out.length;
    const endpoints = [
      (o: number) => `/playlists/${playlistId}/items?offset=${o}&limit=100`,
      (o: number) => `/playlists/${playlistId}/tracks?offset=${o}&limit=100`,
    ];
    outer: for (const build of endpoints) {
      while (out.length < total) {
        try {
          const resp = await spotifyGet<unknown>(user, build(offset));
          user = resp.user;
          const extra = extractTracksPage(resp.data);
          if (!extra || extra.items.length === 0) break;
          normalizeItems(extra.items, out);
          offset += extra.items.length;
          if (extra.items.length < 100) break outer;
        } catch (err) {
          if (err instanceof SpotifyError && (err.status === 403 || err.status === 404)) break;
          throw err;
        }
      }
    }
  }

  return { user, tracks: out };
}

// --- Client Credentials token for public-catalog access.
//
// When SPOTIFY_CLIENT_SECRET is configured, we can request an
// app-scoped bearer token and use it as an alternate fallback for
// playlists that 403 on the user token. App tokens have a separate
// quota pool from the user token and are not subject to user-scope
// restrictions, so they sometimes succeed where the user token fails
// on public playlists.

let cachedAppToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (cachedAppToken && cachedAppToken.expiresAt > Date.now() + 30_000) {
    return cachedAppToken.token;
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  try {
    const res = await spotifyFetch(`${ACCOUNTS}/api/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    const json = await res.json<{ access_token: string; expires_in: number }>();
    cachedAppToken = {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return json.access_token;
  } catch (e) {
    if (e instanceof SpotifyRateLimitError) return null;
    throw e;
  }
}

async function appTokenGet<T>(path: string): Promise<T | null> {
  const tok = await getAppToken();
  if (!tok) return null;
  try {
    const res = await spotifyFetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) return null;
    return await res.json<T>();
  } catch (e) {
    if (e instanceof SpotifyRateLimitError) return null;
    throw e;
  }
}

/**
 * Fetch all tracks of a playlist via the Client Credentials (app token)
 * flow. Returns null if app token is unavailable or if Spotify also
 * blocks the app token on this playlist.
 */
async function fetchAllTracksWithAppToken(
  playlistId: string,
): Promise<TrackKeyed[] | null> {
  // getAppToken() and each doFetch() go through spotifyFetch internally
  // — no manual gate needed. Every call is individually counted.
  const tok = await getAppToken();
  if (!tok) return null;

  const all: TrackKeyed[] = [];
  const doFetch = async (path: string): Promise<unknown> => {
    try {
      const res = await spotifyFetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (e instanceof SpotifyRateLimitError) return null;
      throw e;
    }
  };

  // Try /tracks first, then /items. If the first page 403s on both,
  // bail out.
  let nextPath: string | null =
    `/playlists/${playlistId}/tracks?limit=100&offset=0`;
  let firstOk = false;
  while (nextPath) {
    const data: unknown = await doFetch(nextPath);
    if (!data) {
      if (!firstOk) {
        // Try /items as a shape variant on the first fetch.
        const alt = await doFetch(`/playlists/${playlistId}/items?limit=100&offset=0`);
        if (!alt) return null;
        const page = extractTracksPage(alt);
        if (!page) return null;
        firstOk = true;
        normalizeItems(page.items, all);
        nextPath = page.next ? page.next.replace(API, "") : null;
        continue;
      }
      break;
    }
    const page = extractTracksPage(data);
    if (!page) break;
    firstOk = true;
    normalizeItems(page.items, all);
    nextPath = page.next ? page.next.replace(API, "") : null;
  }
  return all.length > 0 ? all : null;
}

// --- Pathfinder GraphQL fallback for playlists where Spotify blocks
// the public Web API. Uses the same internal API that open.spotify.com's
// web player uses:
//
//   1. Scrape an anonymous access token from the embed page HTML
//      (the __NEXT_DATA__ script includes `accessToken`).
//   2. POST fetchPlaylistContents to api-partner.spotify.com/pathfinder/v2
//      with a persistedQuery sha256Hash extracted from the desktop web
//      player JS bundle. This is the query the real web player uses to
//      render playlist pages, so it sees ALL tracks (not just the first
//      100 like the embed page). Supports offset/limit pagination.
//
// The returned payload includes real addedAt, addedBy, album name,
// album art, and artists — everything we need, no separate enrichment.

// Query hash for `fetchPlaylistContents` extracted from the desktop
// web-player bundle (web-player.*.js). If Spotify rotates this, our
// pathfinder fallback returns 412 Invalid query hash and we'll need to
// scrape the new hash from the bundle at runtime. For now a hard-coded
// hash is simpler than a runtime extractor.
const PATHFINDER_PLAYLIST_HASH =
  "32b05e92e438438408674f95d0fdad8082865dc32acd55bd97f5113b8579092b";

async function fetchAnonAccessToken(
  playlistId: string,
): Promise<string | null> {
  try {
    const res = await spotifyFetch(
      `https://open.spotify.com/embed/playlist/${playlistId}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      },
    );
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"accessToken":"([^"]+)"/);
    return m ? m[1] : null;
  } catch (e) {
    if (e instanceof SpotifyRateLimitError) return null;
    throw e;
  }
}

interface PathfinderTrackItem {
  addedAt?: { isoString?: string };
  addedBy?: { data?: { username?: string; uri?: string } };
  itemV2?: {
    data?: {
      uri?: string;
      name?: string;
      trackDuration?: { totalMilliseconds?: number };
      artists?: { items?: Array<{ profile?: { name?: string } }> };
      albumOfTrack?: {
        name?: string;
        coverArt?: { sources?: Array<{ url?: string; height?: number }> };
      };
    };
  };
}

async function fetchPathfinderPage(
  token: string,
  playlistId: string,
  offset: number,
  limit: number,
): Promise<{ items: PathfinderTrackItem[]; total: number } | null> {
  const body = JSON.stringify({
    operationName: "fetchPlaylistContents",
    variables: {
      uri: `spotify:playlist:${playlistId}`,
      offset,
      limit,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: PATHFINDER_PLAYLIST_HASH,
      },
    },
  });
  try {
    const res = await spotifyFetch("https://api-partner.spotify.com/pathfinder/v2/query", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "App-Platform": "WebPlayer",
        Origin: "https://open.spotify.com",
        Referer: "https://open.spotify.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body,
    });
    if (!res.ok) return null;
    const json = await res.json<{
      data?: {
        playlistV2?: {
          content?: {
            items?: PathfinderTrackItem[];
            totalCount?: number;
          };
        };
      };
    }>();
    const content = json?.data?.playlistV2?.content;
    if (!content || !Array.isArray(content.items)) return null;
    return { items: content.items, total: content.totalCount ?? content.items.length };
  } catch (e) {
    if (e instanceof SpotifyRateLimitError) return null;
    throw e;
  }
}

function normalizePathfinderItems(
  items: PathfinderTrackItem[],
  out: TrackKeyed[],
) {
  for (const it of items) {
    const data = it.itemV2?.data;
    if (!data?.uri) continue;
    const idMatch = data.uri.match(/^spotify:track:([A-Za-z0-9]+)/);
    if (!idMatch) continue;
    const artists = (data.artists?.items ?? [])
      .map((a) => a.profile?.name ?? "")
      .filter(Boolean);
    // Prefer the 300px cover when available, else the first source.
    const coverSources = data.albumOfTrack?.coverArt?.sources ?? [];
    const cover300 =
      coverSources.find((s) => s.height === 300) ?? coverSources[0];
    out.push({
      spotifyTrackId: idMatch[1],
      title: data.name ?? "",
      artists,
      album: data.albumOfTrack?.name ?? null,
      albumImageUrl: cover300?.url ?? null,
      durationMs: data.trackDuration?.totalMilliseconds ?? 0,
      addedAt: it.addedAt?.isoString ?? new Date(0).toISOString(),
      addedBySpotifyId: it.addedBy?.data?.username ?? null,
    });
  }
}

async function fetchAllTracksViaPathfinder(
  playlistId: string,
): Promise<TrackKeyed[] | null> {
  // fetchAnonAccessToken and fetchPathfinderPage each go through
  // spotifyFetch internally — no manual gate needed.
  const token = await fetchAnonAccessToken(playlistId);
  if (!token) return null;
  const out: TrackKeyed[] = [];
  const PAGE = 100;
  let offset = 0;
  // Hard cap at 100 pages (10k tracks) as a safety net.
  for (let guard = 0; guard < 100; guard++) {
    const page = await fetchPathfinderPage(token, playlistId, offset, PAGE);
    if (!page) {
      // First-page failure → give up. Later-page failure → keep what we have.
      if (out.length === 0) return null;
      break;
    }
    normalizePathfinderItems(page.items, out);
    if (page.items.length < PAGE) break;
    offset += page.items.length;
    if (offset >= page.total) break;
  }
  return out.length > 0 ? out : null;
}

// --- Embed-based fallback for playlists where Spotify blocks the Web
// API's track endpoints (403 on /tracks and /items, `tracks` field
// silently stripped from /playlists/{id}). The public embed page at
// https://open.spotify.com/embed/playlist/{id} server-renders a
// `__NEXT_DATA__` script tag containing up to 100 trackList entries.
// Fields available: uri, title, subtitle (artists), duration, audioPreview.
// Missing: album name, album image, addedAt, addedBy. We enrich album
// data via `/v1/tracks?ids=` and synthesize a stable addedAt of epoch.

interface EmbedTrack {
  uri?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
}

async function fetchEmbedTracks(
  userIn: User,
  playlistId: string,
): Promise<{ user: User; tracks: TrackKeyed[] }> {
  // spotifyFetch gates, records, and handles 429 automatically.
  let res;
  try {
    res = await spotifyFetch(
      `https://open.spotify.com/embed/playlist/${playlistId}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    );
  } catch (e) {
    if (e instanceof SpotifyRateLimitError) {
      return { user: userIn, tracks: [] };
    }
    throw e;
  }
  if (!res.ok) {
    throw new SpotifyError(
      res.status,
      await res.text(),
      `Embed fetch failed with ${res.status}`,
    );
  }
  const html = await res.text();
  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) {
    throw new SpotifyError(0, html.slice(0, 400), "Embed HTML has no __NEXT_DATA__");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch (err) {
    throw new SpotifyError(
      0,
      m[1].slice(0, 400),
      `Embed __NEXT_DATA__ parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const entity =
    ((parsed as Record<string, unknown>)?.props as Record<string, unknown>)
      ?.pageProps &&
    (
      ((parsed as Record<string, unknown>).props as Record<string, unknown>)
        .pageProps as Record<string, unknown>
    )?.state &&
    (
      (
        ((parsed as Record<string, unknown>).props as Record<string, unknown>)
          .pageProps as Record<string, unknown>
      ).state as Record<string, unknown>
    )?.data &&
    (
      (
        (
          ((parsed as Record<string, unknown>).props as Record<string, unknown>)
            .pageProps as Record<string, unknown>
        ).state as Record<string, unknown>
      ).data as Record<string, unknown>
    )?.entity;
  const trackList = (entity as { trackList?: EmbedTrack[] } | undefined)
    ?.trackList;
  if (!Array.isArray(trackList)) {
    throw new SpotifyError(
      0,
      JSON.stringify(entity).slice(0, 400),
      "Embed entity has no trackList array",
    );
  }

  // Extract track IDs for album enrichment.
  const trackIds: string[] = [];
  const baseTracks: Array<{
    spotifyTrackId: string;
    title: string;
    artists: string[];
    durationMs: number;
  }> = [];
  for (const t of trackList) {
    const uri = t.uri;
    if (!uri) continue;
    const idMatch = uri.match(/^spotify:track:([A-Za-z0-9]+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    trackIds.push(id);
    baseTracks.push({
      spotifyTrackId: id,
      title: t.title ?? "",
      artists: (t.subtitle ?? "")
        .split(/,\s*/)
        .map((s) => s.trim())
        .filter(Boolean),
      durationMs: t.duration ?? 0,
    });
  }

  // Enrich with album name + album image via /v1/tracks?ids=... (up to 50
  // per request). This catalog endpoint works with user tokens even when
  // per-playlist track endpoints don't, because it's not scoped to the
  // playlist's permissions.
  let user = userIn;
  const albumById = new Map<string, { name: string; image: string | null }>();
  for (let i = 0; i < trackIds.length; i += 50) {
    const batch = trackIds.slice(i, i + 50);
    try {
      const resp = await spotifyGet<{
        tracks: Array<{
          id: string;
          album?: { name: string; images?: SpotifyImage[] };
        } | null>;
      }>(user, `/tracks?ids=${batch.join(",")}`);
      user = resp.user;
      for (const tr of resp.data.tracks) {
        if (!tr) continue;
        albumById.set(tr.id, {
          name: tr.album?.name ?? "",
          image: tr.album?.images?.[0]?.url ?? null,
        });
      }
    } catch {
      // Enrichment is best-effort — continue without album data.
    }
  }

  // Synthetic stable addedAt so diff keys are idempotent across polls.
  // We don't know the true addedAt from the embed, so use epoch for all.
  const stableAddedAt = new Date(0).toISOString();
  const out: TrackKeyed[] = baseTracks.map((b) => ({
    spotifyTrackId: b.spotifyTrackId,
    title: b.title,
    artists: b.artists,
    album: albumById.get(b.spotifyTrackId)?.name ?? null,
    albumImageUrl: albumById.get(b.spotifyTrackId)?.image ?? null,
    durationMs: b.durationMs,
    addedAt: stableAddedAt,
    addedBySpotifyId: null,
  }));
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

// Spotify user IDs are looser than playlist IDs — they can include dots,
// hyphens, and underscores, and there's no minimum length (legacy numeric
// ids like "179366" are 6 chars). Don't enforce min length or charset
// beyond ruling out whitespace and structural URL/URI noise.
export function parseUserId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const uriMatch = trimmed.match(/^spotify:user:([A-Za-z0-9._-]+)/);
  if (uriMatch) return decodeURIComponent(uriMatch[1]);
  const urlMatch = trimmed.match(
    /open\.spotify\.com\/(?:intl-[a-z]+\/)?user\/([A-Za-z0-9._-]+)/,
  );
  if (urlMatch) return decodeURIComponent(urlMatch[1]);
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;
  return null;
}

// Spotify user-profile metadata we care about.
export interface SpotifyUserProfile {
  id: string;
  display_name?: string;
  images?: SpotifyImage[];
}

export async function fetchUserProfile(user: User, spotifyUserId: string) {
  return spotifyGet<SpotifyUserProfile>(
    user,
    `/users/${encodeURIComponent(spotifyUserId)}`,
  );
}

// One playlist as returned in /users/{id}/playlists. Trimmed to fields we
// actually persist on Playlist.
export interface SpotifyUserPlaylistItem {
  id: string;
  name: string;
  snapshot_id?: string;
  images?: SpotifyImage[];
  owner: { id: string; display_name?: string };
  // `public` is nullable on the API for collaborative playlists; we don't
  // filter on it client-side because /users/{id}/playlists already returns
  // only the user's public-visible set.
  public?: boolean | null;
}

interface SpotifyUserPlaylistsPage {
  items: SpotifyUserPlaylistItem[];
  next: string | null;
  total: number;
}

// Cap on how many public playlists we fetch per add/sync. Each page is one
// Spotify call; 4 pages × 50 = 200. The cap exists so a watched user with
// thousands of playlists can't fan out a multi-minute fetch and stall the
// request thread (or burn budget). If we ever hit it, log + surface
// `truncated: true` so it shows up in error reporting.
const MAX_USER_PLAYLIST_PAGES = 4;

/**
 * Fetch the watched user's public playlists. Up to 200 (4 × 50). Each
 * page goes through spotifyGet → spotifyFetch and is therefore guarded
 * by the rate-limit chokepoint and may rotate the user's access token.
 *
 * Fallback chain on 403:
 *   - Tier 1 (default): user OAuth token. Works for most users.
 *   - Tier 2: Client Credentials (app token). Different quota pool, not
 *     subject to user-scope restrictions. Works if SPOTIFY_CLIENT_SECRET
 *     is configured. Many users that 403 on Tier 1 (third-party access
 *     disabled in their privacy settings) succeed on Tier 2 because app
 *     tokens are not gated by user-scope privacy settings — only
 *     playlist-level public/private state.
 *   - Tier 3: anonymous token scraped from a public embed page, hitting
 *     api.spotify.com directly. Same /users/{id}/playlists endpoint, but
 *     the anonymous token has no user identity, so per-account privacy
 *     restrictions don't apply.
 *
 * 429s anywhere in the chain are fatal (do NOT escalate to next tier —
 * they all share Spotify's per-IP / per-account bucket). 403/404 from a
 * tier triggers escalation.
 */
export async function fetchUserPublicPlaylists(
  userIn: User,
  spotifyUserId: string,
): Promise<{
  user: User;
  playlists: SpotifyUserPlaylistItem[];
  truncated: boolean;
}> {
  let user = userIn;
  let firstTierError: SpotifyError | null = null;

  // Tier 1: user OAuth token. The vast majority of watched users go
  // through this path successfully.
  try {
    const result = await fetchUserPublicPlaylistsWithUserToken(
      user,
      spotifyUserId,
    );
    return result;
  } catch (e) {
    if (e instanceof SpotifyError && (e.status === 403 || e.status === 404)) {
      firstTierError = e;
      console.warn(
        `[fetchUserPublicPlaylists] tier 1 (user token) returned ${e.status} for ${spotifyUserId} — escalating to fallbacks`,
      );
      // Pick up the latest user record (token may have rotated mid-call
      // before the 403 fired) before falling through.
    } else {
      throw e;
    }
  }

  // Tier 2: Client Credentials (app token). Returns null silently if
  // SPOTIFY_CLIENT_SECRET is not configured or first page is blocked.
  // If the call succeeds but returns 0 playlists, we still try tier 3
  // before accepting that as truth — Spotify's app-token visibility is
  // sometimes narrower than anon-token visibility for restricted users.
  const appResult = await fetchUserPublicPlaylistsWithAppToken(spotifyUserId);
  if (appResult && appResult.playlists.length > 0) {
    console.warn(
      `[fetchUserPublicPlaylists] tier 2 (app token) returned ${appResult.playlists.length} for ${spotifyUserId} after tier 1 returned ${firstTierError?.status}`,
    );
    return { user, playlists: appResult.playlists, truncated: appResult.truncated };
  }

  // Tier 3: anonymous token scraped from an embed page.
  const anonResult = await fetchUserPublicPlaylistsWithAnonToken(spotifyUserId);
  if (anonResult && anonResult.playlists.length > 0) {
    console.warn(
      `[fetchUserPublicPlaylists] tier 3 (anon token) returned ${anonResult.playlists.length} for ${spotifyUserId} after tier 1 returned ${firstTierError?.status}`,
    );
    return { user, playlists: anonResult.playlists, truncated: anonResult.truncated };
  }

  // If both fallbacks succeeded with 0 playlists each, that's a strong
  // signal the user genuinely has no public playlists — accept it.
  if (appResult || anonResult) {
    const fallback = appResult ?? anonResult!;
    console.warn(
      `[fetchUserPublicPlaylists] all tiers reachable but no public playlists for ${spotifyUserId} — treating as empty`,
    );
    return { user, playlists: fallback.playlists, truncated: fallback.truncated };
  }

  // All tiers failed — surface the original tier-1 error so the user
  // sees the most specific message Spotify gave us.
  throw firstTierError ?? new SpotifyError(
    403,
    null,
    `Could not fetch public playlists for Spotify user "${spotifyUserId}".`,
  );
}

/**
 * Tier 1: user OAuth token fetch of /users/{id}/playlists.
 * Up to 200 playlists (4 × 50). May rotate the access token.
 */
async function fetchUserPublicPlaylistsWithUserToken(
  userIn: User,
  spotifyUserId: string,
): Promise<{
  user: User;
  playlists: SpotifyUserPlaylistItem[];
  truncated: boolean;
}> {
  let user = userIn;
  const out: SpotifyUserPlaylistItem[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_USER_PLAYLIST_PAGES; page++) {
    const offset = page * 50;
    const res = await spotifyGet<SpotifyUserPlaylistsPage>(
      user,
      `/users/${encodeURIComponent(spotifyUserId)}/playlists?limit=50&offset=${offset}`,
    );
    user = res.user;
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    for (const it of items) {
      if (it && it.id) out.push(it);
    }
    if (!res.data?.next) {
      return { user, playlists: out, truncated: false };
    }
    if (page === MAX_USER_PLAYLIST_PAGES - 1 && res.data.next) {
      truncated = true;
    }
  }
  return { user, playlists: out, truncated };
}

/**
 * Tier 2: Client Credentials (app token) fetch. Returns null if
 * SPOTIFY_CLIENT_SECRET is not configured, if Spotify also blocks the
 * app token, or if a 429 is encountered (don't extend the cooldown by
 * escalating).
 */
async function fetchUserPublicPlaylistsWithAppToken(
  spotifyUserId: string,
): Promise<{
  playlists: SpotifyUserPlaylistItem[];
  truncated: boolean;
} | null> {
  const tok = await getAppToken();
  if (!tok) return null;

  const out: SpotifyUserPlaylistItem[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_USER_PLAYLIST_PAGES; page++) {
    const offset = page * 50;
    let res: SpotifyFetchResultLike;
    try {
      res = await spotifyFetch(
        `${API}/users/${encodeURIComponent(spotifyUserId)}/playlists?limit=50&offset=${offset}`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
    } catch (e) {
      // 429 anywhere in the chain → bail. Re-thrown as SpotifyError(429)
      // by the caller's outer try/catch in spotifyGet, but here we just
      // give up to avoid extending the cooldown.
      if (e instanceof SpotifyRateLimitError) return null;
      throw e;
    }
    if (!res.ok) {
      // First-page failure → no fallback (Spotify also blocks app token).
      // Later-page failure → keep what we collected.
      if (page === 0) return null;
      return { playlists: out, truncated };
    }
    const data = await res.json<SpotifyUserPlaylistsPage>();
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const it of items) {
      if (it && it.id) out.push(it);
    }
    if (!data?.next) {
      return { playlists: out, truncated: false };
    }
    if (page === MAX_USER_PLAYLIST_PAGES - 1 && data.next) {
      truncated = true;
    }
  }
  return { playlists: out, truncated };
}

/**
 * Tier 3: anonymous token (scraped from a stable public embed page)
 * fetch. Returns null if the token can't be obtained, the call 403s,
 * or a 429 is encountered.
 *
 * Why this works: the anonymous token has no user identity attached, so
 * per-account privacy settings ("third-party access disabled") don't
 * apply. The endpoint is the same /users/{id}/playlists, just with a
 * different auth context.
 */
const ANON_BOOTSTRAP_PLAYLIST_ID = "37i9dQZF1DXcBWIGoYBM5M"; // Today's Top Hits — stable, public, Spotify-curated.

async function fetchUserPublicPlaylistsWithAnonToken(
  spotifyUserId: string,
): Promise<{
  playlists: SpotifyUserPlaylistItem[];
  truncated: boolean;
} | null> {
  const tok = await fetchAnonAccessToken(ANON_BOOTSTRAP_PLAYLIST_ID);
  if (!tok) return null;

  const out: SpotifyUserPlaylistItem[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_USER_PLAYLIST_PAGES; page++) {
    const offset = page * 50;
    let res: SpotifyFetchResultLike;
    try {
      res = await spotifyFetch(
        `${API}/users/${encodeURIComponent(spotifyUserId)}/playlists?limit=50&offset=${offset}`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
    } catch (e) {
      if (e instanceof SpotifyRateLimitError) return null;
      throw e;
    }
    if (!res.ok) {
      if (page === 0) return null;
      return { playlists: out, truncated };
    }
    const data = await res.json<SpotifyUserPlaylistsPage>();
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const it of items) {
      if (it && it.id) out.push(it);
    }
    if (!data?.next) {
      return { playlists: out, truncated: false };
    }
    if (page === MAX_USER_PLAYLIST_PAGES - 1 && data.next) {
      truncated = true;
    }
  }
  return { playlists: out, truncated };
}

// Local alias so we don't need to drag the full SpotifyFetchResult shape
// from rate-limit.ts into this file's signatures.
type SpotifyFetchResultLike = Awaited<ReturnType<typeof spotifyFetch>>;
