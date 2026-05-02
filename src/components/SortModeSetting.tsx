"use client";

import { useSortModePreference } from "@/lib/sort-mode";

export function SortModeSetting() {
  const [mode, setMode] = useSortModePreference();
  const baseClass =
    "flex-1 rounded border px-3 py-1.5 text-xs transition-colors";
  const activeClass =
    "border-spotify bg-spotify/10 text-spotify";
  const inactiveClass =
    "border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="font-medium">Playlist sort order</h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Adds this week surfaces what&apos;s moving and auto-collapses
        inactive sections. Manual keeps your drag-and-drop order with
        every section expanded.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("weekly")}
          className={`${baseClass} ${mode === "weekly" ? activeClass : inactiveClass}`}
        >
          Adds this week
        </button>
        <button
          type="button"
          onClick={() => setMode("manual")}
          className={`${baseClass} ${mode === "manual" ? activeClass : inactiveClass}`}
        >
          Manual
        </button>
      </div>
    </div>
  );
}
