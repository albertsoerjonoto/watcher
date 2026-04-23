"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { DASHBOARD_KEY } from "./DashboardContent";

export function AddPlaylistForm() {
  const { mutate } = useSWRConfig();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
      setUrl("");
      mutate(DASHBOARD_KEY);
      // Kick off track seeding in the background.
      const newId = body.playlist?.id;
      if (newId) {
        fetch(`/api/playlists/${newId}/retry`, { method: "POST" })
          .then(() => mutate(DASHBOARD_KEY))
          .catch(() => {});
      }
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
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
