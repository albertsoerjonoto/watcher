"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr-fetcher";
import { SETTINGS_KEY } from "./settings-keys";
import { NotificationToggles } from "./NotificationToggles";
import { SectionNotifyToggles } from "./SectionNotifyToggles";
import { EnablePush } from "./EnablePush";
import { SortModeSetting } from "./SortModeSetting";
import type { SettingsData } from "@/lib/settings-data";

interface Props {
  fallbackData: SettingsData;
}

export function SettingsContent({ fallbackData }: Props) {
  const { data } = useSWR<SettingsData>(SETTINGS_KEY, fetcher, {
    fallbackData,
  });

  // data is always defined because of fallbackData.
  const { user, subCount, watchedUsers, playlists } = data!;

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <div className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Account</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Signed in as {user.displayName ?? user.spotifyId}
        </p>
        <form action="/api/auth/logout" method="post">
          <button className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">
            Sign out
          </button>
        </form>
      </div>

      <SortModeSetting />

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Push notifications</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {subCount} device(s) subscribed.
        </p>
        <EnablePush />
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Notify by section</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Master switches per section. A playlist notifies only if its
          section is on AND the playlist itself is enabled below.
        </p>
        <SectionNotifyToggles
          initial={{
            notifyMain: user.notifyMain,
            notifyNew: user.notifyNew,
            notifyOther: user.notifyOther,
          }}
        />
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Per-playlist notifications</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Grouped by watched user and section. The user-row checkbox
          toggles every playlist for that user; section-row toggles
          all in that section. Sort order follows your dashboard
          preference above.
        </p>
        <NotificationToggles
          watchedUsers={watchedUsers}
          playlists={playlists}
        />
      </div>
    </section>
  );
}
