"use client";

import { useState } from "react";

// Per-row section selector: Main / New / Other.
//
// Lives next to the existing PlaylistActions cluster (move/delete) and
// is rendered only when the dashboard is in edit mode. Surfaces server-
// side cap errors (409 main_cap_reached) inline so the user sees why
// promotion was blocked.

export type Section = "main" | "new" | "other";

interface Props {
  current: Section;
  onChange: (next: Section) => Promise<void>;
  // Display-only: how many Main playlists currently exist for this
  // watched user, used to disable Main when the cap is full.
  mainCount: number;
  cap: number;
  disabled?: boolean;
}

const LABELS: Record<Section, string> = {
  main: "Main",
  new: "New",
  other: "Other",
};

export function SectionPicker({
  current,
  onChange,
  mainCount,
  cap,
  disabled,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(next: Section) {
    if (busy || disabled || next === current) return;
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  // Disable Main if the cap is reached AND this row isn't already Main
  // (you can always keep Main; you just can't add more).
  const mainAtCap = mainCount >= cap && current !== "main";

  return (
    <div className="flex flex-col gap-1">
      <div
        role="group"
        aria-label="Move to section"
        className="flex shrink-0 items-center overflow-hidden rounded border border-neutral-200 text-[10px] dark:border-neutral-800"
      >
        {(["main", "new", "other"] as const).map((s) => {
          const isCurrent = s === current;
          const isDisabled = busy || disabled || (s === "main" && mainAtCap);
          return (
            <button
              key={s}
              type="button"
              disabled={isDisabled}
              onClick={() => handle(s)}
              title={
                s === "main" && mainAtCap
                  ? `Main is full (${cap})`
                  : `Move to ${LABELS[s]}`
              }
              className={
                isCurrent
                  ? "bg-spotify px-2 py-0.5 font-semibold text-black"
                  : "px-2 py-0.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }
            >
              {LABELS[s]}
            </button>
          );
        })}
      </div>
      {error && (
        <span className="text-[10px] text-red-600 dark:text-red-400">
          {error === "main_cap_reached"
            ? `Main is full (${cap})`
            : error}
        </span>
      )}
    </div>
  );
}
