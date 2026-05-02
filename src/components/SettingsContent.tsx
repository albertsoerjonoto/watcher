"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr-fetcher";
import { SETTINGS_KEY } from "./settings-keys";
import { NotificationToggles } from "./NotificationToggles";
import { SectionNotifyToggles } from "./SectionNotifyToggles";
import { EnablePush } from "./EnablePush";
import { SortModeSetting } from "./SortModeSetting";
import type { SettingsData } from "@/lib/settings-data";

// No fallbackData — SSR returns just the shell so the function is fast.
// SWRProvider's localStorage cache means repeat visits paint instantly.
// First-ever visit shows the static section frames while the API call
// completes (~300ms typically).
export function SettingsContent() {
  const { data } = useSWR<SettingsData>(SETTINGS_KEY, fetcher);

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <div className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Account</h2>
        {data ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Signed in as {data.user.displayName ?? data.user.spotifyId}
          </p>
        ) : (
          <div className="h-4 w-40 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
        )}
        <form action="/api/auth/logout" method="post">
          <button className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">
            Sign out
          </button>
        </form>
      </div>

      <SortModeSetting />

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Push notifications</h2>
        {data ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {data.subCount} device(s) subscribed.
          </p>
        ) : (
          <div className="h-4 w-32 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
        )}
        <EnablePush />
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Notify by section</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Master switches per section. A playlist notifies only if its
          section is on AND the playlist itself is enabled below.
        </p>
        {data ? (
          <SectionNotifyToggles
            initial={{
              notifyMain: data.user.notifyMain,
              notifyNew: data.user.notifyNew,
              notifyOther: data.user.notifyOther,
            }}
          />
        ) : (
          <div className="h-6 w-48 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Per-playlist notifications</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Grouped by watched user and section. The user-row checkbox
          toggles every playlist for that user; section-row toggles
          all in that section. Sort order follows your dashboard
          preference above.
        </p>
        {data ? (
          <NotificationToggles
            watchedUsers={data.watchedUsers}
            playlists={data.playlists}
          />
        ) : (
          <div className="space-y-2">
            <div className="h-12 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
            <div className="h-12 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
          </div>
        )}
      </div>
    </section>
  );
}
