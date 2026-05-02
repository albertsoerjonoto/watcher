"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { ArrowUpDown, Pencil, Plus } from "lucide-react";
import { AddPlaylistForm } from "./AddPlaylistForm";
import { AddWatchedUserForm } from "./AddWatchedUserForm";
import { InstallHint } from "./InstallHint";
import { DashboardPlaylistList } from "./DashboardPlaylistList";
import { DASHBOARD_KEY } from "./dashboard-keys";
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
  const {
    watchedUsers,
    playlists,
    recentByPlaylist,
    weekByPlaylist,
    errorByPlaylist,
    hasPushSub,
    needsReauth,
    cooldownSeconds,
  } = data!;

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(false);
  // "weekly" (default) = sort by added-this-week count desc; sections
  // with no weekly activity auto-collapse so the dashboard surfaces
  // what's moving this week. "manual" = the user's drag-and-drop order
  // (Edit > Move ↑/↓), with all sections expanded.
  const [sortMode, setSortMode] = useState<"weekly" | "manual">("weekly");

  return (
    <section className="space-y-6">
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

      {showAdd && (
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
        errorByPlaylist={errorByPlaylist}
        editing={editing}
        sortMode={sortMode}
        toolbar={
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              onClick={() => {
                setShowAdd(!showAdd);
                if (editing) setEditing(false);
              }}
              title={showAdd ? "Hide add form" : "Add playlist or watched user"}
              aria-label="Add"
              className={
                showAdd
                  ? "text-spotify"
                  : "text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"
              }
            >
              <Plus className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() =>
                setSortMode(sortMode === "weekly" ? "manual" : "weekly")
              }
              title={
                sortMode === "manual"
                  ? "Currently in your manual order. Click to sort by adds-this-week."
                  : "Sorting by adds-this-week. Click to switch to your manual order."
              }
              aria-label="Toggle sort order"
              className={
                sortMode === "manual"
                  ? "text-spotify"
                  : "text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"
              }
            >
              <ArrowUpDown className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(!editing);
                if (showAdd) setShowAdd(false);
              }}
              title={editing ? "Done editing" : "Edit playlists"}
              aria-label="Edit"
              className={
                editing
                  ? "text-spotify"
                  : "text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"
              }
            >
              <Pencil className="h-5 w-5" />
            </button>
          </div>
        }
      />
    </section>
  );
}
