// Diagnostic endpoint: hits Spotify with several request variants so we
// can isolate why /tracks returns 403 while /me and playlist meta work.
//
// Usage: /api/debug/probe?id=<playlist spotify id or URL>
//
// Auth: must be signed in (uses stored user access token).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { parsePlaylistId } from "@/lib/spotify";
import type { User } from "@prisma/client";

const API = "https://api.spotify.com/v1";

async function probe(user: User, path: string) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const text = await res.text();
    // Include top-level keys for JSON responses so we can tell at a
    // glance whether Spotify silently dropped a field (e.g. `tracks`).
    let topKeys: string[] | undefined;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        topKeys = Object.keys(parsed);
      }
    } catch {
      // not JSON
    }
    return {
      path,
      status: res.status,
      topKeys,
      body: text.slice(0, 3000),
    };
  } catch (err) {
    return {
      path,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const url = new URL(request.url);
  const idParam = url.searchParams.get("id") ?? "";
  const playlistId = parsePlaylistId(idParam);
  if (!playlistId) {
    return NextResponse.json(
      { error: "pass ?id=<playlist URL or spotify id>" },
      { status: 400 },
    );
  }

  // Fire probes sequentially so we preserve order in the response.
  const probes = [
    await probe(user, "/me"),
    await probe(user, `/playlists/${playlistId}`),
    await probe(
      user,
      `/playlists/${playlistId}?fields=id,name,snapshot_id,owner(id,display_name)`,
    ),
    await probe(user, `/playlists/${playlistId}/tracks?limit=5`),
    await probe(user, `/playlists/${playlistId}/tracks?limit=100`),
    await probe(user, `/playlists/${playlistId}/items?limit=5`),
    await probe(user, `/playlists/${playlistId}/items?limit=100`),
    await probe(
      user,
      `/playlists/${playlistId}/tracks?limit=5&market=from_token`,
    ),
    await probe(
      user,
      `/playlists/${playlistId}/tracks?limit=5&market=ID`,
    ),
    await probe(user, `/playlists/${playlistId}?fields=tracks.total`),
    await probe(user, `/playlists/${playlistId}?market=from_token`),
    await probe(user, `/playlists/${playlistId}?fields=items.total`),
    await probe(user, `/playlists/${playlistId}?fields=items(added_at,track(id,name))`),
    await probe(user, `/playlists/${playlistId}?fields=items`),
    await probe(user, `/playlists/${playlistId}?additional_types=track,episode`),
    // Probe open.spotify.com anon-token endpoint from Vercel IP (blocked from some regions).
    await (async () => {
      try {
        const r = await fetch(
          "https://open.spotify.com/get_access_token?reason=transport&productType=embed",
          { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } },
        );
        const text = await r.text();
        return { path: "[anon-token]", status: r.status, body: text.slice(0, 800) };
      } catch (err) {
        return { path: "[anon-token]", status: 0, body: String(err) };
      }
    })(),
    // Probe the embed page from Vercel.
    await (async () => {
      try {
        const r = await fetch(
          `https://open.spotify.com/embed/playlist/${playlistId}`,
          { headers: { "User-Agent": "Mozilla/5.0" } },
        );
        const text = await r.text();
        const hasNextData = text.includes("__NEXT_DATA__");
        const trackIdCount = (text.match(/spotify:track:[A-Za-z0-9]{22}/g) ?? []).length;
        return { path: "[embed]", status: r.status, body: `nextData=${hasNextData} trackIds=${trackIdCount} size=${text.length}` };
      } catch (err) {
        return { path: "[embed]", status: 0, body: String(err) };
      }
    })(),
    // Scrape anon token from embed HTML, then hit /tracks?offset=100 from Vercel.
    await (async () => {
      try {
        const embed = await fetch(
          `https://open.spotify.com/embed/playlist/${playlistId}`,
          { headers: { "User-Agent": "Mozilla/5.0" } },
        );
        const text = await embed.text();
        const m = text.match(/"accessToken":"([^"]+)"/);
        if (!m) return { path: "[anon-tracks]", status: 0, body: "no token in embed" };
        const anonTok = m[1];
        const r = await fetch(
          `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&offset=100`,
          {
            headers: {
              Authorization: `Bearer ${anonTok}`,
              "User-Agent": "Mozilla/5.0",
              Origin: "https://open.spotify.com",
              Referer: `https://open.spotify.com/embed/playlist/${playlistId}`,
              "App-Platform": "WebPlayer",
            },
          },
        );
        const body = await r.text();
        return { path: "[anon-tracks]", status: r.status, body: body.slice(0, 800) };
      } catch (err) {
        return { path: "[anon-tracks]", status: 0, body: String(err) };
      }
    })(),
    await probe(
      user,
      `/playlists/${playlistId}?fields=name,tracks.items(added_at,track(id,name))`,
    ),
    await probe(
      user,
      `/playlists/${playlistId}?fields=name,tracks(items(added_at,track(id,name)),next,total)`,
    ),
    await probe(user, "/me/playlists?limit=5"),
  ];

  return NextResponse.json({
    user: {
      id: user.id,
      spotifyId: user.spotifyId,
      displayName: user.displayName,
      tokenExpiresAt: user.tokenExpiresAt,
      tokenExpiresInMs: user.tokenExpiresAt.getTime() - Date.now(),
    },
    playlistId,
    probes,
  });
}
