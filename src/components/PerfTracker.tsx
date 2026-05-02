"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// SPA navigation timing logger. On every pathname change, measures the
// time from the click that triggered the nav until the next paint and
// logs e.g. `[NAV] /feed: 87ms (cache: hit)` to the console.
//
// "cache: hit" means no /api/* fetch fired during the transition;
// "api: /api/feed" means the page hit the network. This distinction
// lets QA verify (via Chrome MCP read_console_messages) whether the
// SWR + localStorage caching is short-circuiting the network on warm
// navigations.
//
// First mount (hard load) is skipped — that's covered by Performance
// Navigation Timing, not by us.
export function PerfTracker() {
  const pathname = usePathname();
  const startRef = useRef<number | null>(null);
  const resourceCountRef = useRef<number>(0);
  const isFirstMount = useRef(true);

  useEffect(() => {
    function onClick(ev: MouseEvent) {
      const anchor = (ev.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      // Same-origin internal nav only. External, hash, mailto: are
      // someone else's problem.
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      startRef.current = performance.now();
      resourceCountRef.current =
        performance.getEntriesByType("resource").length;
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    const start = startRef.current;
    const beforeCount = resourceCountRef.current;
    if (start == null) return;
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
        const note =
          apiCalls.length === 0
            ? "(cache: hit)"
            : `(api: ${apiCalls.join(",")})`;
        // eslint-disable-next-line no-console
        console.log(`[NAV] ${path}: ${ms}ms ${note}`);
        startRef.current = null;
      });
    });
  }, [pathname]);

  return null;
}
