"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { DASHBOARD_KEY } from "./dashboard-keys";
import { drainPendingPolls } from "./drain-pending";

export function AddPlaylistForm() {
  const { mutate } = useSWRConfig();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to add playlist");
      }
      const body = (await res.json()) as {
        playlist?: { id?: string };
      };
      const newId = body.playlist?.id;
      setUrl("");
      mutate(DASHBOARD_KEY);

      // Try the fast path: a single /retry call. On a clean window this
      // returns 200 and the post-poll attach hook in pollPlaylist
      // (src/lib/poll.ts:265) sets watchedUserId before we even get
      // here. The playlist appears under its WatchedUser immediately.
      let retryOk = false;
      if (newId) {
        try {
          const retryRes = await fetch(`/api/playlists/${newId}/retry`, {
            method: "POST",
          });
          retryOk = retryRes.ok;
        } catch {
          retryOk = false;
        }
      }

      // Fallback: /retry was 429 (cooldown OR cross-instance batch
      // throttle). Without this fallback the playlist sat in "Pending"
      // until the next AutoRefresh tick caught a clean window — which
      // on a quiet tab could be hours, and on Hobby (no second cron
      // tick for 24h) effectively forever. drainPendingPolls handles
      // both 429 reasons with proper backoff.
      if (!retryOk) {
        setStatus("Added — waiting for sync window…");
        await drainPendingPolls((s) => setStatus(`Added — ${s}`));
      }

      mutate(DASHBOARD_KEY);
      setStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label className="block text-sm text-neutral-500 dark:text-neutral-400">
        Add a Spotify playlist
      </label>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          placeholder="https://open.spotify.com/playlist/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !url}
          className="rounded bg-spotify px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {status && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {status}
        </p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
