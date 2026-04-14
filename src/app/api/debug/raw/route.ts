// Minimal debug endpoint: fetches /playlists/{id} once and returns the
// top-level keys plus a structural summary of `items` (or `tracks`) and
// a small sample of item entries so we can figure out why a specific
// playlist is being parsed as 0 tracks without triggering the heavier
// multi-probe endpoint (which can time out).
//
// Usage: /api/debug/raw?id=<playlist id or URL>

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { parsePlaylistId, spotifyGet } from "@/lib/spotify";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function summarize(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    return {
      __array: true,
      length: value.length,
      sample: depth < 2 ? value.slice(0, 2).map((v) => summarize(v, depth + 1)) : undefined,
    };
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    const out: Record<string, unknown> = { __keys: keys };
    if (depth < 3) {
      for (const k of keys.slice(0, 20)) {
        out[k] = summarize(o[k], depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > 120 ? value.slice(0, 120) + "…" : value;
  }
  return value;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const url = new URL(request.url);
  const idParam = url.searchParams.get("id") ?? "";
  const playlistId = parsePlaylistId(idParam);
  if (!playlistId) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  try {
    const { data } = await spotifyGet<unknown>(
      user,
      `/playlists/${playlistId}`,
    );
    return NextResponse.json({
      playlistId,
      summary: summarize(data),
    });
  } catch (err) {
    return NextResponse.json(
      {
        playlistId,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
