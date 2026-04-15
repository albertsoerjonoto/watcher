"use client";

import { useState } from "react";

// Per-row action cluster on the dashboard: move up, move down, delete.
// Reorder is a server-side renumber (see /api/playlists/reorder); we
// just hit the endpoint and then force a real reload so the dashboard
// re-renders with the new ordering.
//
// We pre-render disabled states for the boundary rows (top/bottom)
// so the user gets immediate feedback that the buttons are inert.
//
// Why `location.reload()` instead of `router.refresh()`:
// `router.refresh()` inside `startTransition` was silently not
// re-rendering after a successful POST on production (Next 14.2.5) —
// the API returned 200, the DB was updated, a hard reload showed the
// new order, but the in-app click looked like a no-op because the
// Router Cache wasn't invalidated in time. A hard reload costs ~300ms
// on force-dynamic pages and is unambiguously correct.
export function PlaylistActions({
  playlistId,
  playlistName,
  isFirst,
  isLast,
  onMove,
  onDelete,
}: {
  playlistId: string;
  playlistName: string;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: "up" | "down") => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        title="Move up"
        disabled={busy || isFirst}
        onClick={() => withBusy(() => onMove("up"))}
        className="rounded border border-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
      >
        ↑
      </button>
      <button
        type="button"
        title="Move down"
        disabled={busy || isLast}
        onClick={() => withBusy(() => onMove("down"))}
        className="rounded border border-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
      >
        ↓
      </button>
      <button
        type="button"
        title={`Delete ${playlistName}`}
        disabled={busy}
        onClick={() => {
          if (
            !confirm(
              `Stop watching "${playlistName}"? This removes its tracks and history from the dashboard.`,
            )
          ) {
            return;
          }
          withBusy(onDelete);
        }}
        className="rounded border border-red-900/60 px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-30"
      >
        ✕
      </button>
    </div>
  );
}

// Convenience wrapper that talks to the API for a given playlist id.
// Lives in the same module so the dashboard server component can pass
// just the id and let the client handle the fetches.
export function PlaylistActionsClient({
  playlistId,
  playlistName,
  isFirst,
  isLast,
  prevId,
  nextId,
}: {
  playlistId: string;
  playlistName: string;
  isFirst: boolean;
  isLast: boolean;
  prevId: string | null;
  nextId: string | null;
}) {
  async function move(direction: "up" | "down") {
    const otherId = direction === "up" ? prevId : nextId;
    if (!otherId) return;
    await fetch(`/api/playlists/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: playlistId, b: otherId }),
    });
  }
  async function del() {
    await fetch(`/api/playlists/${playlistId}`, { method: "DELETE" });
  }
  return (
    <PlaylistActions
      playlistId={playlistId}
      playlistName={playlistName}
      isFirst={isFirst}
      isLast={isLast}
      onMove={move}
      onDelete={del}
    />
  );
}
