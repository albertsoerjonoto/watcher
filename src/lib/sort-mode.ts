"use client";

import { useEffect, useState } from "react";

export type SortMode = "weekly" | "manual";

const STORAGE_KEY = "watcher.sortMode";
const DEFAULT_MODE: SortMode = "weekly";

function readStored(): SortMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === "weekly" || raw === "manual" ? raw : DEFAULT_MODE;
}

// Persistent per-device sort preference for the dashboard. Writes to
// localStorage and broadcasts a same-tab "watcher:sortMode" event so
// open Dashboard + Settings tabs stay in sync without a refresh.
export function useSortModePreference(): [SortMode, (mode: SortMode) => void] {
  const [mode, setMode] = useState<SortMode>(DEFAULT_MODE);

  useEffect(() => {
    setMode(readStored());
    function onChange(e: Event) {
      const next = (e as CustomEvent<SortMode>).detail;
      if (next === "weekly" || next === "manual") setMode(next);
    }
    window.addEventListener("watcher:sortMode", onChange);
    return () => window.removeEventListener("watcher:sortMode", onChange);
  }, []);

  function update(next: SortMode) {
    window.localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(
      new CustomEvent<SortMode>("watcher:sortMode", { detail: next }),
    );
    setMode(next);
  }

  return [mode, update];
}
