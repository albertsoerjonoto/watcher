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
  ms: number;
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
      });
    });
  }, [pathname]);

  return null;
}
