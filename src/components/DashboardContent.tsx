"use client";

import useSWR from "swr";
import Link from "next/link";
import { AddPlaylistForm } from "./AddPlaylistForm";
import { AutoRefresh } from "./AutoRefresh";
import { InstallHint } from "./InstallHint";
import {
  DashboardPlaylistList,
  type PlaylistRow,
  type TrackRow,
} from "./DashboardPlaylistList";

interface DashboardData {
  playlists: PlaylistRow[];
  recentByPlaylist: Record<string, TrackRow[]>;
  weekByPlaylist: Record<string, number>;
  errorByPlaylist: Record<string, string>;
  hasPushSub: boolean;
  needsReauth: boolean;
  cooldownSeconds: number;
  user: { displayName: string | null; spotifyId: string };
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

export const DASHBOARD_KEY = "/api/dashboard";

interface Props {
  fallbackData: DashboardData;
}

export function DashboardContent({ fallbackData }: Props) {
  const { data } = useSWR<DashboardData>(DASHBOARD_KEY, fetcher, {
    fallbackData,
    // Revalidate on focus so tab-switching shows fresh data instantly.
    revalidateOnFocus: true,
    // 30s dedup window — prevents rapid refetches.
    dedupingInterval: 30_000,
  });

  // data is always defined because of fallbackData.
  const {
    playlists,
    recentByPlaylist,
    weekByPlaylist,
    errorByPlaylist,
    hasPushSub,
    needsReauth,
    cooldownSeconds,
    user,
  } = data!;

  return (
    <section className="space-y-6">
      <InstallHint />

      {needsReauth && (
        <div className="rounded-lg border border-red-700 bg-red-950/50 p-4">
          <p className="mb-2 text-sm font-semibold text-red-200">
            Your Spotify session expired
          </p>
          <p className="mb-3 text-xs text-red-300">
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
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
          Spotify is rate-limiting us right now. Syncing will resume in
          ~{cooldownSeconds}s. Existing tracks and dates aren&apos;t
          affected.
        </div>
      )}

      {!hasPushSub && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-4">
          <p className="mb-2 text-sm font-semibold text-amber-200">
            Notifications aren&apos;t enabled on this device
          </p>
          <p className="mb-3 text-xs text-amber-300/90">
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

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Watched playlists</h1>
          <p className="text-sm text-neutral-400">
            Signed in as {user.displayName ?? user.spotifyId}
          </p>
        </div>
        <AutoRefresh />
      </div>

      <AddPlaylistForm />

      <DashboardPlaylistList
        playlists={playlists}
        recentByPlaylist={recentByPlaylist}
        weekByPlaylist={weekByPlaylist}
        errorByPlaylist={errorByPlaylist}
      />
    </section>
  );
}
