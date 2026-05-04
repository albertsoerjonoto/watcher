"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { AddPlaylistForm } from "./AddPlaylistForm";
import { AddWatchedUserForm } from "./AddWatchedUserForm";
import { InstallHint } from "./InstallHint";
import { DashboardPlaylistList } from "./DashboardPlaylistList";
import { DASHBOARD_KEY } from "./dashboard-keys";
import { useSortModePreference } from "@/lib/sort-mode";
import type { DashboardData } from "@/lib/dashboard-data";

// Re-export so existing callers that imported DASHBOARD_KEY from
// DashboardContent keep working (e.g. AddPlaylistForm).
export { DASHBOARD_KEY };

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

interface Props {
  fallbackData: DashboardData;
}

export function DashboardContent({ fallbackData }: Props) {
  const { data } = useSWR<DashboardData>(DASHBOARD_KEY, fetcher, {
    fallbackData,
    revalidateOnFocus: true,
    dedupingInterval: 30_000,
  });

  // data is always defined because of fallbackData.
  //
  // Defaults for record-shaped fields belt-and-suspender against a
  // localStorage-cached response from a prior deploy that lacked a
  // newer field — e.g. latestAddedAtByPlaylist was added in PR #99,
  // and old caches without it crashed the sort comparator before the
  // SWRProvider cache-version bump landed. STORAGE_KEY versioning is
  // the primary defense; these defaults are the floor.
  const {
    watchedUsers = [],
    playlists = [],
    recentByPlaylist = {},
    weekByPlaylist = {},
    latestAddedAtByPlaylist = {},
    errorByPlaylist = {},
    hasPushSub = false,
    needsReauth = false,
    cooldownSeconds = 0,
  } = data!;

  const [editing, setEditing] = useState(false);
  // "weekly" (default) = sort by latest track addedAt desc, so playlists
  // with the most recent additions surface first; sections with no
  // adds-this-week still auto-collapse so the dashboard hides quiet
  // surfaces. "manual" = the user's drag-and-drop order (Edit > Move
  // ↑/↓), with all sections expanded. Persisted in localStorage and
  // toggled from Settings.
  const [sortMode] = useSortModePreference();

  // Edit lives in the global top nav (rendered by the root layout)
  // via a portal slot. Toggling Edit also surfaces the Add forms below
  // — adding and editing are the same "modify your watchlist" mode.
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setToolbarTarget(document.getElementById("dashboard-toolbar-slot"));
  }, []);

  const toolbar = (
    <button
      type="button"
      onClick={() => setEditing(!editing)}
      title={editing ? "Done editing" : "Edit playlists"}
      aria-label="Edit"
      className={
        editing
          ? "text-spotify"
          : "text-neutral-400 hover:text-black dark:hover:text-white"
      }
    >
      <Pencil className="h-5 w-5" />
    </button>
  );

  return (
    <section className="space-y-6">
      {toolbarTarget && createPortal(toolbar, toolbarTarget)}
      <InstallHint />

      {needsReauth && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-700 dark:bg-red-950/50">
          <p className="mb-2 text-sm font-semibold text-red-900 dark:text-red-200">
            Your Spotify session expired
          </p>
          <p className="mb-3 text-xs text-red-800 dark:text-red-300">
            Spotify rejected the stored refresh token. Sign in again to
            continue — this will not delete your watched playlists.
          </p>
          <a
            href="/api/auth/login"
            className="inline-block rounded-full bg-spotify px-4 py-2 text-sm font-semibold text-black"
          >
            Sign in with Spotify again
          </a>
        </div>
      )}

      {cooldownSeconds > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
          Spotify is rate-limiting us right now. Syncing will resume in
          ~{cooldownSeconds}s. Existing tracks and dates aren&apos;t
          affected.
        </div>
      )}

      {!hasPushSub && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700/50 dark:bg-amber-950/30">
          <p className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
            Notifications aren&apos;t enabled on this device
          </p>
          <p className="mb-3 text-xs text-amber-800 dark:text-amber-300/90">
            The whole point of this app is to ping you when new songs are
            added to a watched playlist. Open Settings to subscribe — on
            iPhone you must add the app to your Home Screen first.
          </p>
          <Link
            href="/settings"
            className="inline-block rounded-full bg-amber-500 px-4 py-2 text-xs font-semibold text-black"
          >
            Enable notifications
          </Link>
        </div>
      )}

      {editing && (
        <div className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <AddWatchedUserForm />
          <hr className="border-neutral-200 dark:border-neutral-800" />
          <AddPlaylistForm />
        </div>
      )}

      <DashboardPlaylistList
        watchedUsers={watchedUsers}
        playlists={playlists}
        recentByPlaylist={recentByPlaylist}
        weekByPlaylist={weekByPlaylist}
        latestAddedAtByPlaylist={latestAddedAtByPlaylist}
        errorByPlaylist={errorByPlaylist}
        editing={editing}
        sortMode={sortMode}
      />
    </section>
  );
}
