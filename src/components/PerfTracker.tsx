"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// SPA navigation timing logger. On every pathname change, measures the
// time from the click that triggered the nav until the next paint and
// records `{ path, ms, cacheHit, apiCalls, at }` to both:
//   - console.log via `[NAV] /feed: 87ms (cache: hit)`
//   - window.__watcherNav.entries (last 50)
//
// The window export exists because Chrome MCP's read_console_messages
// only reliably surfaces exceptions in headless QA — reading from
// window via javascript_tool is the QA-friendly path. DevTools users
// see the console line.
//
// "cache: hit" means no /api/* fetch fired during the transition;
// "api: /api/feed" means the page hit the network. This distinction
// lets QA verify whether the SWR + localStorage caching is
// short-circuiting the network on warm navigations.
//
// Timing state is module-level (not useRef) because in App Router,
// some layouts re-mount on navigation, which would zero out per-instance
// refs. Module-level state survives the remount; the click and the
// pathname-change effect can be in different PerfTracker instances and
// still talk to each other through this shared state.

interface NavEntry {
  path: string;
  // ms = click → first paint (skeleton or content). Always populated.
  ms: number;
  // settledMs = click → no new fetches for SETTLED_QUIET_MS. Populated
  // asynchronously after the page stops fetching. The actual user-perceived
  // "ready" time. Null if still settling when read.
  settledMs: number | null;
  cacheHit: boolean;
  apiCalls: string[];
  at: number;
}

declare global {
  interface Window {
    __watcherNav?: { entries: NavEntry[] };
  }
}

let listenerInstalled = false;
let startTime: number | null = null;
let startResourceCount = 0;

// Time-to-settled = first window of SETTLED_QUIET_MS during which no
// new resource fetched after the click. 250ms is short enough to feel
// instant but long enough to avoid false positives from a single
// straggling image.
const SETTLED_QUIET_MS = 250;
const SETTLED_TIMEOUT_MS = 5_000;

function installClickListener() {
  if (listenerInstalled || typeof document === "undefined") return;
  listenerInstalled = true;
  document.addEventListener(
    "click",
    (ev) => {
      const anchor = (ev.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      // Same-origin internal nav only.
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      startTime = performance.now();
      startResourceCount = performance.getEntriesByType("resource").length;
    },
    true,
  );
}

export function PerfTracker() {
  const pathname = usePathname();

  useEffect(() => {
    installClickListener();
  }, []);

  useEffect(() => {
    const start = startTime;
    if (start == null) return; // No click captured — hard load or back/forward.
    const beforeCount = startResourceCount;
    const path = pathname;

    // Two rAFs: first lets React commit, second lets the browser paint.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const ms = Math.round(performance.now() - start);
        const newResources = performance
          .getEntriesByType("resource")
          .slice(beforeCount);
        const apiCalls = newResources
          .map((r) => {
            try {
              return new URL(r.name).pathname;
            } catch {
              return r.name;
            }
          })
          .filter((p) => p.startsWith("/api/"));
        const cacheHit = apiCalls.length === 0;
        const note = cacheHit
          ? "(cache: hit)"
          : `(api: ${apiCalls.join(",")})`;
        const entry: NavEntry = {
          path,
          ms,
          settledMs: null,
          cacheHit,
          apiCalls,
          at: Date.now(),
        };
        if (!window.__watcherNav) window.__watcherNav = { entries: [] };
        window.__watcherNav.entries.push(entry);
        if (window.__watcherNav.entries.length > 50) {
          window.__watcherNav.entries.shift();
        }
        // eslint-disable-next-line no-console
        console.log(`[NAV] ${path}: ${ms}ms ${note}`);
        startTime = null;

        // Async: poll resource entries until SETTLED_QUIET_MS passes
        // with no new fetches. Updates entry.settledMs in place.
        let lastResourceCount = performance.getEntriesByType("resource").length;
        let lastChangeAt = performance.now();
        const settledStart = start;
        const poll = () => {
          const now = performance.now();
          const count = performance.getEntriesByType("resource").length;
          if (count !== lastResourceCount) {
            lastResourceCount = count;
            lastChangeAt = now;
          }
          if (now - lastChangeAt >= SETTLED_QUIET_MS) {
            entry.settledMs = Math.round(lastChangeAt - settledStart);
            // eslint-disable-next-line no-console
            console.log(`[NAV-SETTLED] ${path}: ${entry.settledMs}ms`);
            return;
          }
          if (now - settledStart > SETTLED_TIMEOUT_MS) {
            entry.settledMs = -1; // never settled within timeout
            return;
          }
          setTimeout(poll, 50);
        };
        setTimeout(poll, 50);
      });
    });
  }, [pathname]);

  return null;
}
