"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { DASHBOARD_KEY } from "./dashboard-keys";

// Sibling of AddPlaylistForm. Adds a new WatchedUser by Spotify URL/URI
// or bare id. The POST goes through /api/watched-users which:
//   - Double-gates against the persisted cooldown
//   - Fetches profile (1 call) + paginated public playlists (1-4 calls)
//   - Drops every playlist into section="other" (no notifications)

export function AddWatchedUserForm() {
  const { mutate } = useSWRConfig();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/watched-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        skipped?: string;
        cooldownSeconds?: number;
        watchedUser?: { displayName?: string | null; spotifyId?: string };
        added?: number;
        total?: number;
        truncated?: boolean;
      };
      if (body.skipped === "cooldown") {
        throw new Error(
          `Spotify is rate-limiting us. Try again in ~${body.cooldownSeconds}s.`,
        );
      }
      if (!res.ok) {
        throw new Error(body.error ?? `request failed (${res.status})`);
      }
      const wu = body.watchedUser;
      const label = wu?.displayName ?? wu?.spotifyId ?? "watched user";
      setSuccess(
        `Watching ${label} — ${body.total ?? 0} playlist(s) in Other${
          body.truncated ? " (truncated to first 200)" : ""
        }. Promote your favorites to Main.`,
      );
      setUrl("");
      mutate(DASHBOARD_KEY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label className="block text-sm text-neutral-500 dark:text-neutral-400">
        Watch a new Spotify user
      </label>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          placeholder="https://open.spotify.com/user/179366"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !url}
          className="rounded bg-spotify px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Fetching…" : "Watch"}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      {success && (
        <p className="text-sm text-spotify">{success}</p>
      )}
      <p className="text-xs text-neutral-500">
        Their public playlists land in Other. Promote up to 12 to Main —
        only Main and New send notifications.
      </p>
    </form>
  );
}
