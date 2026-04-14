"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Mounted on the dashboard. On first paint (and whenever the tab becomes
// visible again) it POSTs /api/refresh to pull fresh tracks from Spotify,
// then router.refresh()es the RSC so the new rows show up without a
// hard reload. This is the substitute for a high-frequency cron job on
// Vercel Hobby (which only runs daily).
//
// Guardrails:
//   - Debounced with a minimum interval of 20 seconds so rapid tab
//     switches don't hammer Spotify.
//   - If the refresh is in-flight, subsequent triggers are coalesced.
//   - On failure we quietly log to the console — a failed refresh
//     should never block the dashboard from rendering.
export function AutoRefresh() {
  const router = useRouter();
  const lastRunRef = useRef<number>(0);
  const busyRef = useRef<boolean>(false);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busyRef.current) return;
    const now = Date.now();
    if (now - lastRunRef.current < 20_000) return;
    lastRunRef.current = now;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.ok) {
        // Don't throw — we just drop the update and let the user retry.
        // eslint-disable-next-line no-console
        console.warn("[auto-refresh] /api/refresh failed:", res.status);
      } else {
        router.refresh();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[auto-refresh] error:", err);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    run();
    function onVisible() {
      if (document.visibilityState === "visible") run();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // run() is stable for the lifetime of the component — it only
    // captures refs and the router, which Next guarantees is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex items-center gap-2 text-[10px] text-neutral-500">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          busy ? "animate-pulse bg-spotify" : "bg-neutral-700"
        }`}
      />
      {busy ? "syncing…" : "up to date"}
    </div>
  );
}
