"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { AlertCircle, Check, Clock, RefreshCw } from "lucide-react";
import { DASHBOARD_KEY } from "./DashboardContent";

// Mounted on the dashboard. Before firing the real /api/refresh (which
// polls Spotify), it first GETs /api/sync-status — a pure-DB endpoint
// that reports (a) the current Spotify cooldown in seconds and (b) how
// many playlists are actually stale enough to warrant a re-poll.
//
// The refresh only happens when BOTH gates pass:
//   - cooldownSeconds === 0
//   - staleCount > 0
type SyncState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "syncing" }
  | { kind: "ok"; new: number; at: number }
  | { kind: "fresh" } // nothing to refresh — all playlists recently checked
  | { kind: "error"; message: string }
  | { kind: "rateLimited"; secondsRemaining: number };

interface RefreshResponse {
  skipped?: "cooldown" | "fresh";
  cooldownSeconds?: number;
  results?: { newTracks: number; error?: string }[];
}

interface StatusResponse {
  cooldownSeconds: number;
  staleCount: number;
  totalActive: number;
  staleThresholdMinutes: number;
}

export function AutoRefresh() {
  const { mutate } = useSWRConfig();
  const lastRunRef = useRef<number>(0);
  const busyRef = useRef<boolean>(false);
  const [state, setState] = useState<SyncState>({ kind: "idle" });

  async function run(force = false) {
    if (busyRef.current) return;
    const now = Date.now();
    if (!force && now - lastRunRef.current < 10_000) return;
    lastRunRef.current = now;
    busyRef.current = true;
    setState({ kind: "checking" });
    try {
      const statusRes = await fetch("/api/sync-status", { cache: "no-store" });
      if (!statusRes.ok) {
        if (statusRes.status === 401) {
          setState({ kind: "idle" });
          return;
        }
        setState({ kind: "error", message: `status ${statusRes.status}` });
        return;
      }
      const status = (await statusRes.json()) as StatusResponse;
      if (status.cooldownSeconds > 0) {
        setState({
          kind: "rateLimited",
          secondsRemaining: status.cooldownSeconds,
        });
        return;
      }
      if (status.staleCount === 0 && !force) {
        setState({ kind: "fresh" });
        return;
      }

      setState({ kind: "syncing" });
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.ok) {
        setState({ kind: "error", message: `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as RefreshResponse;
      if (body.skipped === "cooldown") {
        setState({
          kind: "rateLimited",
          secondsRemaining: body.cooldownSeconds ?? 0,
        });
        return;
      }
      if (body.skipped === "fresh") {
        setState({ kind: "fresh" });
        return;
      }
      const totalNew =
        body.results?.reduce((acc, r) => acc + (r.newTracks ?? 0), 0) ?? 0;
      const allErrors = body.results?.filter((r) => r.error) ?? [];
      const firstRealError = allErrors.find(
        (r) => !r.error?.includes("429") && !r.error?.includes("cooldown"),
      )?.error;
      const firstRateLimit = allErrors[0]?.error;
      if (firstRealError) {
        setState({ kind: "error", message: firstRealError });
      } else if (firstRateLimit && allErrors.length > 0) {
        const m = firstRateLimit.match(/retry after (\d+)s/i);
        setState({
          kind: "rateLimited",
          secondsRemaining: m ? Number(m[1]) : 0,
        });
      } else {
        setState({ kind: "ok", new: totalNew, at: Date.now() });
      }
      // Revalidate SWR cache so the dashboard updates without a full
      // page reload.
      mutate(DASHBOARD_KEY);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let Icon: typeof RefreshCw = RefreshCw;
  let iconClass = "h-5 w-5 text-neutral-500 dark:text-neutral-400";
  let label: string = "Sync now";
  let disabled = false;
  if (state.kind === "checking") {
    Icon = RefreshCw;
    iconClass = "h-5 w-5 animate-spin text-neutral-500 dark:text-neutral-400";
    label = "Checking…";
    disabled = true;
  } else if (state.kind === "syncing") {
    Icon = RefreshCw;
    iconClass = "h-5 w-5 animate-spin text-spotify";
    label = "Syncing…";
    disabled = true;
  } else if (state.kind === "ok") {
    Icon = Check;
    iconClass = "h-5 w-5 text-spotify";
    label = state.new > 0 ? `+${state.new} new` : "Up to date";
  } else if (state.kind === "fresh") {
    Icon = Check;
    iconClass = "h-5 w-5 text-neutral-500 dark:text-neutral-400";
    label = "Up to date";
  } else if (state.kind === "rateLimited") {
    Icon = Clock;
    iconClass = "h-5 w-5 text-amber-500";
    label = state.secondsRemaining
      ? `Rate limited — retry in ${state.secondsRemaining}s`
      : "Rate limited";
  } else if (state.kind === "error") {
    Icon = AlertCircle;
    iconClass = "h-5 w-5 text-red-500";
    label = state.message || "Sync error";
  }

  if (state.kind === "idle") return null;

  return (
    <button
      type="button"
      onClick={() => run(true)}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="text-neutral-600 hover:text-black dark:text-neutral-300 dark:hover:text-white disabled:opacity-60"
    >
      <Icon className={iconClass} />
    </button>
  );
}
