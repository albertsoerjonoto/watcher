"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Mounted on the dashboard. On first paint (and whenever the tab becomes
// visible again) it POSTs /api/refresh to pull fresh tracks from Spotify,
// then router.refresh()es the RSC so the new rows show up without a
// hard reload. This is the substitute for a high-frequency cron job on
// Vercel Hobby (which only runs once a day).
//
// Visible state on the dashboard header tells the user whether a sync
// is in flight and what came back. The state is intentionally chatty
// because the previous "syncing… / up to date" badge made it impossible
// to tell whether a manual click actually did anything.
type SyncState =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "ok"; new: number; at: number }
  | { kind: "error"; message: string }
  | { kind: "rateLimited"; message: string };

interface RefreshResponse {
  results?: { newTracks: number; error?: string }[];
}

export function AutoRefresh() {
  const router = useRouter();
  const lastRunRef = useRef<number>(0);
  const busyRef = useRef<boolean>(false);
  const [state, setState] = useState<SyncState>({ kind: "idle" });

  async function run(force = false) {
    if (busyRef.current) return;
    const now = Date.now();
    // 5s minimum between automatic syncs so rapid tab-switches don't
    // hammer Spotify, but a manual click bypasses the debounce.
    if (!force && now - lastRunRef.current < 5_000) return;
    lastRunRef.current = now;
    busyRef.current = true;
    setState({ kind: "syncing" });
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.ok) {
        setState({
          kind: "error",
          message: `HTTP ${res.status}`,
        });
        return;
      }
      const body = (await res.json()) as RefreshResponse;
      const totalNew =
        body.results?.reduce((acc, r) => acc + (r.newTracks ?? 0), 0) ?? 0;
      const allErrors = body.results?.filter((r) => r.error) ?? [];
      const firstRealError = allErrors.find(
        (r) => !r.error?.includes("429"),
      )?.error;
      const firstRateLimit = allErrors[0]?.error;
      if (firstRealError) {
        setState({ kind: "error", message: firstRealError });
      } else if (firstRateLimit && allErrors.length > 0) {
        // Every poll in the batch rate-limited. Surface that
        // distinctly so "sync error" red isn't alarming — it's not
        // actually broken, just throttled.
        setState({ kind: "rateLimited", message: firstRateLimit });
      } else {
        setState({ kind: "ok", new: totalNew, at: Date.now() });
      }
      router.refresh();
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      busyRef.current = false;
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

  let dotClass = "bg-neutral-700";
  let label: string = "ready";
  if (state.kind === "syncing") {
    dotClass = "animate-pulse bg-spotify";
    label = "syncing…";
  } else if (state.kind === "ok") {
    dotClass = "bg-spotify";
    label = state.new > 0 ? `+${state.new} new` : "up to date";
  } else if (state.kind === "rateLimited") {
    dotClass = "bg-amber-500";
    const m = state.message.match(/retry after (\d+)s/i);
    label = m ? `rate limited · ${m[1]}s` : "rate limited";
  } else if (state.kind === "error") {
    dotClass = "bg-red-500";
    label = "sync error";
  }

  return (
    <div className="flex items-center gap-2 text-[10px] text-neutral-500">
      <button
        type="button"
        onClick={() => run(true)}
        disabled={state.kind === "syncing"}
        title={
          state.kind === "error" || state.kind === "rateLimited"
            ? state.message
            : "Sync now"
        }
        className="flex items-center gap-1.5 rounded border border-neutral-800 px-2 py-1 hover:bg-neutral-900 disabled:opacity-60"
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`}
        />
        {label}
      </button>
    </div>
  );
}
