"use client";

import { useEffect, useRef, useState } from "react";

// Per-row action cluster on the dashboard: move up, move down, delete.
//
// Optimistic, no page reload. On click we swap the current <li> with
// its neighbor directly in the DOM, fire the POST in the background,
// and revert on failure. Because the owner-group <ul> contains only
// same-owner rows, "previousElementSibling"/"nextElementSibling" is
// naturally the within-group neighbor that reorder should act on.
//
// Why not router.refresh / Server Action + useOptimistic:
//   - router.refresh() inside startTransition silently no-ops on
//     Next 14.2.5 force-dynamic routes (verified on production).
//   - A Server Action rewrite would be cleaner but touches a lot more
//     of the dashboard for what's really a single-row UX fix.
//
// Boundary buttons (first/last in a group) can't move anywhere, so
// we still accept the server-rendered isFirst/isLast as an *initial*
// hint and recompute after any optimistic swap by walking the DOM.
// If a click fires at a boundary we no-op locally — the server would
// reject it anyway with "bad request".

interface BaseProps {
  playlistName: string;
  isFirst: boolean;
  isLast: boolean;
}

export function PlaylistActions({
  playlistName,
  isFirst,
  isLast,
  onMove,
  onDelete,
}: BaseProps & {
  onMove: (direction: "up" | "down", otherId: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  // DOM-driven disabled state so button hints stay correct after an
  // optimistic swap (without round-tripping to the server).
  const [atFirst, setAtFirst] = useState(isFirst);
  const [atLast, setAtLast] = useState(isLast);

  function li(): HTMLLIElement | null {
    return rootRef.current?.closest("li") ?? null;
  }
  function recomputeBounds(row: HTMLLIElement) {
    setAtFirst(!row.previousElementSibling);
    setAtLast(!row.nextElementSibling);
  }

  // Recompute this instance's bounds any time ANY row in the same ul
  // fires a "playlistreorder" event. Without this, the row that was
  // displaced by someone else's Move click keeps its old disabled
  // state until the next real render.
  useEffect(() => {
    const row = li();
    if (!row) return;
    const ul = row.parentElement;
    if (!ul) return;
    const handler = () => {
      const r = li();
      if (r) recomputeBounds(r);
    };
    ul.addEventListener("playlistreorder", handler);
    return () => ul.removeEventListener("playlistreorder", handler);
  }, []);

  async function move(direction: "up" | "down") {
    const row = li();
    if (!row) return;
    const sibling =
      direction === "up"
        ? (row.previousElementSibling as HTMLLIElement | null)
        : (row.nextElementSibling as HTMLLIElement | null);
    if (!sibling) return;
    const otherId = sibling.dataset.playlistId;
    if (!otherId) return;
    const parent = row.parentElement;
    if (!parent) return;

    setBusy(true);
    // Optimistic swap.
    if (direction === "up") {
      parent.insertBefore(row, sibling);
    } else {
      parent.insertBefore(sibling, row);
    }
    recomputeBounds(row);
    // Also refresh bounds on the sibling so its buttons update.
    // React doesn't control the sibling — it has its own component
    // instance — but its internal DOM ref will see new siblings on
    // its next render. For now we fire a native event so siblings
    // that also listen can recompute. Cheap belt-and-suspenders.
    row.dispatchEvent(
      new CustomEvent("playlistreorder", { bubbles: true }),
    );

    try {
      await onMove(direction, otherId);
    } catch {
      // Revert on failure: swap back.
      if (direction === "up") {
        parent.insertBefore(sibling, row);
      } else {
        parent.insertBefore(row, sibling);
      }
      recomputeBounds(row);
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    const row = li();
    if (!row) return;
    if (
      !confirm(
        `Stop watching "${playlistName}"? This removes its tracks and history from the dashboard.`,
      )
    ) {
      return;
    }
    setBusy(true);
    // Optimistic hide. We toggle display rather than removing the node
    // so revert on failure is a one-liner.
    const prevDisplay = row.style.display;
    row.style.display = "none";
    try {
      await onDelete();
    } catch {
      row.style.display = prevDisplay;
      setBusy(false);
    }
    // On success leave the row hidden — a subsequent nav will refetch.
  }

  return (
    <div ref={rootRef} className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        title="Move up"
        disabled={busy || atFirst}
        onClick={() => move("up")}
        className="rounded border border-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
      >
        ↑
      </button>
      <button
        type="button"
        title="Move down"
        disabled={busy || atLast}
        onClick={() => move("down")}
        className="rounded border border-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
      >
        ↓
      </button>
      <button
        type="button"
        title={`Delete ${playlistName}`}
        disabled={busy}
        onClick={del}
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
}: {
  playlistId: string;
  playlistName: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  async function move(_direction: "up" | "down", otherId: string) {
    const res = await fetch(`/api/playlists/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: playlistId, b: otherId }),
    });
    if (!res.ok) throw new Error(`reorder ${res.status}`);
  }
  async function del() {
    const res = await fetch(`/api/playlists/${playlistId}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`delete ${res.status}`);
  }
  return (
    <PlaylistActions
      playlistName={playlistName}
      isFirst={isFirst}
      isLast={isLast}
      onMove={move}
      onDelete={del}
    />
  );
}
