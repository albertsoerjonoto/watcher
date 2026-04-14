"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Per-row action cluster on the dashboard: move up, move down, delete.
// Reorder is implemented as a swap with the neighbor's sortOrder; the
// server PATCH endpoint only stores the new sortOrder for one playlist
// at a time, so we fire two PATCHes in parallel.
//
// We pre-render disabled states for the boundary rows (top/bottom)
// so the user gets immediate feedback that the buttons are inert.
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
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      startTransition(() => router.refresh());
    } finally {
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
