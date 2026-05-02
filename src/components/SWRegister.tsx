"use client";

import { useEffect } from "react";

// Registers /sw.js on page load. Returns null. Mounted in the root layout.
//
// Why register here instead of only in EnablePush: the service worker
// owns the stale-while-revalidate page cache that makes PWA cold
// launches show last-known content INSTANTLY. Push is a secondary use
// — every visit benefits from page caching.
//
// Idempotent: register() is a no-op if the same script URL is already
// registered. We deliberately don't call .update() here to avoid
// fighting browsers that auto-check on cycle.
export function SWRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Silent failure — first-class browsers handle this; if we got
      // a register error, page-level caching just doesn't kick in.
    });
  }, []);
  return null;
}
