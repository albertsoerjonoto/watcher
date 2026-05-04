"use client";

import { type ReactNode } from "react";
import { SWRConfig, type Cache } from "swr";

// Persists the SWR cache to localStorage so a hard reload still shows
// stale-but-valid data on the very next paint (then revalidates in the
// background). Without this, every reload starts cold and the user
// stares at a skeleton until /api/* responds.
//
// Mounted once at the root layout. Global config:
//  - revalidateOnFocus: true        — auto-refresh when user comes back
//  - revalidateOnReconnect: true    — auto-refresh after offline → online
//  - dedupingInterval: 30s          — burst-clicks don't refetch
//  - keepPreviousData: true         — show stale UI during background refetch
//
// All localStorage access is try/catch'd. If storage is unavailable
// (private browsing, full quota, embedded view), we silently fall
// back to memory-only — SWR still works, just doesn't survive reload.
//
// CACHE VERSION DISCIPLINE: STORAGE_KEY embeds a version suffix. Bump
// it whenever any /api/* response shape changes in a non-additive way
// (renamed/removed field, narrower type, struct→array reshape) OR
// when a consumer starts reading a field that didn't exist before
// without a defensive default. Old cached entries that lack the new
// field would otherwise hydrate into the page and crash on first
// access — exactly the regression that drove v1→v2 (PR added
// latestAddedAtByPlaylist; old caches missing it crashed the dashboard
// sort comparator). Old keys are also explicitly purged below to
// avoid leaving dead localStorage entries forever.

const STORAGE_KEY = "watcher:swr-cache-v2";
const STALE_STORAGE_KEYS = ["watcher:swr-cache"];
const SAVE_DEBOUNCE_MS = 250;

function makeProvider(): Cache {
  // SWR's Cache<Data> interface is structurally a Map<string, State<Data>>.
  // A plain Map satisfies it at runtime; the cast at the bottom carries us
  // through the State<Data> value-type narrowing — which we don't enforce
  // per-key here.
  const map = new Map<string, unknown>();
  if (typeof window === "undefined") return map as unknown as Cache;

  // Purge any stale cache versions before hydrating the current one.
  // Without this, old keys would sit in localStorage forever after a
  // version bump, wasting quota on data nothing reads.
  try {
    for (const k of STALE_STORAGE_KEYS) window.localStorage.removeItem(k);
  } catch {
    // localStorage unavailable — fine, nothing to purge.
  }

  // Hydrate from localStorage.
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as [string, unknown][];
      for (const [k, v] of parsed) map.set(k, v);
    }
  } catch {
    // corrupted JSON or storage unavailable — start empty
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    try {
      const entries = Array.from(map.entries());
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // QuotaExceededError or similar — give up, stay memory-only.
    }
  };
  const scheduleSave = () => {
    if (saveTimer != null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist();
    }, SAVE_DEBOUNCE_MS);
  };

  // Wrap mutators so every cache change schedules a save.
  const originalSet = map.set.bind(map);
  const originalDelete = map.delete.bind(map);
  map.set = (key: string, value: unknown) => {
    const r = originalSet(key, value);
    scheduleSave();
    return r;
  };
  map.delete = (key: string) => {
    const r = originalDelete(key);
    scheduleSave();
    return r;
  };

  // Final sync save before the tab unloads.
  window.addEventListener("beforeunload", () => {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persist();
  });

  return map as unknown as Cache;
}

export function SWRProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: makeProvider,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        dedupingInterval: 30_000,
        keepPreviousData: true,
      }}
    >
      {children}
    </SWRConfig>
  );
}
