"use client";

import Link from "next/link";
import useSWR from "swr";
import {
  dayKeyJakarta,
  formatDateJakarta,
  formatTimeJakarta,
} from "@/lib/datetime";
import { fetcher } from "@/lib/swr-fetcher";
import { FEED_KEY } from "./feed-keys";
import { TrackLinks } from "./TrackLinks";
import type { FeedData, FeedFilter, FeedRow } from "@/lib/feed-data";

const FILTER_OPTIONS: { value: FeedFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "main", label: "Main" },
  { value: "new", label: "New" },
  { value: "other", label: "Other" },
];

interface Props {
  filter: FeedFilter;
  fallbackData: FeedData;
}

export function FeedContent({ filter, fallbackData }: Props) {
  // SWR key incorporates the filter so each filter has its own cache slot
  // — switching filters keeps the others warm. Combined with the
  // SWRProvider's localStorage persistence, repeat visits to /feed
  // (any filter) paint instantly from cache, then revalidate.
  const { data, isLoading } = useSWR<FeedData>(FEED_KEY(filter), fetcher, {
    fallbackData,
  });

  const events = data?.events ?? [];

  // Two-level grouping: day -> playlist -> tracks. Map iteration order
  // preserves insertion order, and events arrive in addedAt DESC, so
  // playlist groups within a day naturally sort by their newest track first.
  const groups = new Map<string, Map<string, FeedRow[]>>();
  for (const e of events) {
    const k = dayKeyJakarta(e.addedAt);
    let day = groups.get(k);
    if (!day) {
      day = new Map();
      groups.set(k, day);
    }
    let bucket = day.get(e.playlistId);
    if (!bucket) {
      bucket = [];
      day.set(e.playlistId, bucket);
    }
    bucket.push(e);
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Feed</h1>
        <nav className="flex items-center gap-1 text-xs">
          {FILTER_OPTIONS.map((opt) => {
            const active = opt.value === filter;
            const href =
              opt.value === "all" ? "/feed" : `/feed?filter=${opt.value}`;
            return (
              <Link
                key={opt.value}
                href={href}
                className={
                  active
                    ? "rounded-full bg-spotify/20 px-3 py-1 font-semibold text-spotify"
                    : "rounded-full px-3 py-1 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
                }
              >
                {opt.label}
              </Link>
            );
          })}
        </nav>
      </div>
      {groups.size === 0 && !isLoading && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {filter === "all"
            ? "No tracks yet. Add some playlists from the dashboard."
            : `No tracks in ${filter}.`}
        </p>
      )}
      {Array.from(groups.entries()).map(([day, playlists]) => (
        <div key={day} className="space-y-5">
          <h2 className="text-xs uppercase tracking-wide text-neutral-500">
            {formatDateJakarta(day)}
          </h2>
          {Array.from(playlists.entries()).map(([playlistId, items]) => (
            <div key={playlistId} className="space-y-2">
              <Link
                href={`/playlists/${playlistId}`}
                className="flex items-center gap-3"
              >
                {items[0].playlistImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={items[0].playlistImageUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded bg-neutral-200 dark:bg-neutral-800" />
                )}
                <span className="truncate text-lg font-semibold hover:underline">
                  {items[0].playlistName}
                </span>
              </Link>
              <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {items.map((e) => {
                  const artists = JSON.parse(e.artists) as string[];
                  return (
                    <li
                      key={e.id}
                      className="flex items-center gap-3 p-2.5 text-sm"
                    >
                      {e.albumImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={e.albumImageUrl}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div className="h-8 w-8 shrink-0 rounded bg-neutral-200 dark:bg-neutral-800" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium">{e.title}</div>
                        <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                          {artists.join(", ")}
                        </div>
                      </div>
                      <time className="shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                        {formatTimeJakarta(e.addedAt)}
                      </time>
                      <TrackLinks
                        track={{
                          title: e.title,
                          artists: e.artists,
                          spotifyTrackId: e.spotifyTrackId,
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
