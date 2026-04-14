"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AddPlaylistForm() {
  const router = useRouter();
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
      setUrl("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label className="block text-sm text-neutral-400">
        Add a Spotify playlist
      </label>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
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
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
