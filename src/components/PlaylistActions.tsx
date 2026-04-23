"use client";

import { useState } from "react";

// Per-row action cluster on the dashboard: move up, move down, delete.
//
// Purely prop-driven — no DOM walking, no custom events. The parent
// DashboardPlaylistList owns the playlist order in React state and
// passes isFirst/isLast + callbacks. This replaces the old DOM-based
// approach that used insertBefore/nextElementSibling and broke when
// React re-rendered the list (e.g. after AutoRefresh).

interface Props {
  playlistName: string;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: "up" | "down") => void;
  onDelete: () => void;
}

export function PlaylistActions({
  playlistName,
  isFirst,
  isLast,
  onMove,
  onDelete,
}: Props) {
  const [busy, setBusy] = useState(false);

  function move(direction: "up" | "down") {
    if (busy) return;
    setBusy(true);
    onMove(direction);
    // Brief busy state to prevent accidental double-clicks.
    // The parent handles optimistic state + API call + revert.
    setTimeout(() => setBusy(false), 200);
  }

  function del() {
    if (
      !confirm(
        `Stop watching "${playlistName}"? This removes its tracks and history from the dashboard.`,
      )
    ) {
      return;
    }
    onDelete();
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        title="Move up"
        disabled={busy || isFirst}
        onClick={() => move("up")}
        className="rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        ↑
      </button>
      <button
        type="button"
        title="Move down"
        disabled={busy || isLast}
        onClick={() => move("down")}
        className="rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        ↓
      </button>
      <button
        type="button"
        title={`Delete ${playlistName}`}
        disabled={busy}
        onClick={del}
        className="rounded border border-red-300 px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-30 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        ✕
      </button>
    </div>
  );
}
