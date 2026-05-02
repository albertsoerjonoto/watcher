"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSWRConfig } from "swr";
import { PlaylistActions } from "./PlaylistActions";
import { RetryButton } from "./RetryButton";
import { SectionPicker, type Section } from "./SectionPicker";
import { DASHBOARD_KEY } from "./dashboard-keys";
import { formatDateJakarta, formatDateTimeJakarta } from "@/lib/datetime";
import { MAX_MAIN_PER_WATCHED_USER } from "@/lib/stale";

// Re-export the shared types so existing imports
// (`import { type PlaylistRow } from "./DashboardPlaylistList"`) keep
// working. The source of truth lives in @/lib/dashboard-data.
export type {
  PlaylistRow,
  TrackRow,
  WatchedUserRow,
} from "@/lib/dashboard-data";

import type {
  PlaylistRow,
  TrackRow,
  WatchedUserRow,
} from "@/lib/dashboard-data";

interface Props {
  watchedUsers: WatchedUserRow[];
  playlists: PlaylistRow[];
  recentByPlaylist: Record<string, TrackRow[]>;
  weekByPlaylist: Record<string, number>;
  errorByPlaylist: Record<string, string>;
  editing?: boolean;
  sortMode?: "default" | "weekly";
  toolbar?: React.ReactNode;
}

interface SectionBuckets {
  main: PlaylistRow[];
  new: PlaylistRow[];
  other: PlaylistRow[];
}

const SECTION_ORDER: Section[] = ["main", "new", "other"];
const SECTION_LABELS: Record<Section, string> = {
  main: "Main",
  new: "New",
  other: "Other",
};

// Drain the never-polled-yet queue by repeatedly calling
// /api/playlists/poll-pending until `remaining` is 0. On a 429
// cooldown, sleep for the reported seconds (capped at 30s per wait so
// the UI stays interactive) and retry. Caller passes a status callback
// so the syncMessage can show progress in real time.
async function drainPendingPolls(
  onStatus: (status: string) => void,
): Promise<void> {
  const MAX_LOOPS = 60; // ~5 min at 5/loop is plenty for typical 50-playlist syncs.
  let polledTotal = 0;
  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const res = await fetch("/api/playlists/poll-pending", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      polled?: number;
      remaining?: number;
      hitRateLimit?: boolean;
      skipped?: string;
      cooldownSeconds?: number;
    };
    if (body.skipped === "cooldown") {
      const wait = Math.min(body.cooldownSeconds ?? 5, 30);
      onStatus(
        `rate-limited, waiting ${wait}s (${body.remaining ?? "?"} pending)`,
      );
      await sleep(wait * 1000);
      continue;
    }
    polledTotal += body.polled ?? 0;
    const remaining = body.remaining ?? 0;
    if (remaining === 0) {
      onStatus(`polled ${polledTotal}`);
      return;
    }
    onStatus(`polled ${polledTotal}, ${remaining} pending`);
    if (body.hitRateLimit) {
      // Brief pause to let the rate limit window slide.
      await sleep(5000);
    } else {
      // Brief pause between batches even on success — keeps us under
      // the rolling-30s budget when there are many playlists.
      await sleep(800);
    }
  }
  onStatus(`gave up after ${MAX_LOOPS} loops`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function DashboardPlaylistList({
  watchedUsers: initialWatchedUsers,
  playlists: initialPlaylists,
  recentByPlaylist,
  weekByPlaylist,
  errorByPlaylist,
  editing = false,
  sortMode = "default",
  toolbar,
}: Props) {
  const [playlists, setPlaylists] = useState(initialPlaylists);
  // Mirror of playlists state for reading inside async queue callbacks
  // without abusing setPlaylists as a read-only side channel.
  const playlistsRef = useRef(initialPlaylists);
  // Serial queue ref to prevent concurrent reorder API calls from racing.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  // Sync local state when SWR revalidates with new data from the server.
  // useState only uses initialPlaylists on mount; this effect keeps the
  // list current after AutoRefresh/mutate triggers a background refetch.
  // We compare playlist IDs to avoid overwriting in-flight optimistic
  // reorders with stale server data — if only the order changed, the
  // optimistic state is likely more current than the server response.
  const prevIdsRef = useRef(initialPlaylists.map((p) => p.id).join(","));
  useEffect(() => {
    const newIds = initialPlaylists.map((p) => p.id).join(",");
    const currentIds = playlistsRef.current.map((p) => p.id).join(",");
    if (newIds !== prevIdsRef.current || currentIds === prevIdsRef.current) {
      setPlaylists(initialPlaylists);
      playlistsRef.current = initialPlaylists;
    }
    prevIdsRef.current = newIds;
  }, [initialPlaylists]);

  // Group playlists by (watchedUserId, section). Orphans (watchedUserId
  // null) collect under the "_orphan" pseudo-key — these are stub rows
  // added via POST /api/playlists that haven't been polled yet, so we
  // don't know their owner.
  //
  // sortMode applies INSIDE each section bucket — Main and Other are
  // sorted independently. "default" preserves the user's manual
  // ordering (server-provided sortOrder + insertion order). "weekly"
  // sorts by adds-this-week count desc, with the default order as a
  // stable tiebreaker for playlists that share a count (including 0).
  const grouped = useMemo(() => {
    const map = new Map<string, SectionBuckets>();
    const ensure = (key: string): SectionBuckets => {
      let b = map.get(key);
      if (!b) {
        b = { main: [], new: [], other: [] };
        map.set(key, b);
      }
      return b;
    };
    for (const p of playlists) {
      const key = p.watchedUserId ?? "_orphan";
      const buckets = ensure(key);
      const sec: Section = (p.section as Section) ?? "main";
      buckets[sec].push(p);
    }
    if (sortMode === "weekly") {
      for (const buckets of map.values()) {
        for (const sec of SECTION_ORDER) {
          // Capture original index BEFORE sorting so the tiebreaker
          // preserves the user's manual order for playlists with the
          // same weekly-add count.
          const indexed = buckets[sec].map((p, i) => ({ p, i }));
          indexed.sort((a, b) => {
            const wa = weekByPlaylist[a.p.id] ?? 0;
            const wb = weekByPlaylist[b.p.id] ?? 0;
            if (wb !== wa) return wb - wa; // desc
            return a.i - b.i;
          });
          buckets[sec] = indexed.map(({ p }) => p);
        }
      }
    }
    return map;
  }, [playlists, sortMode, weekByPlaylist]);

  // Live main counts per watchedUserId, derived from current state so
  // SectionPicker reflects optimistic moves. Falls back to server-
  // provided count on the orphan key (which has no WatchedUser).
  const mainCountByWatchedUserId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of playlists) {
      if (p.section !== "main") continue;
      const key = p.watchedUserId ?? "_orphan";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [playlists]);

  const movePlaylist = useCallback(
    (playlistId: string, direction: "up" | "down") => {
      // Swap with neighbor in the same (watchedUser, section) bucket.
      setPlaylists((prev) => {
        const playlist = prev.find((p) => p.id === playlistId);
        if (!playlist) return prev;
        const ownerKey = playlist.watchedUserId ?? "_orphan";
        const bucketIndices = prev
          .map((p, i) => ({ p, i }))
          .filter(
            ({ p }) =>
              (p.watchedUserId ?? "_orphan") === ownerKey &&
              p.section === playlist.section,
          )
          .map(({ i }) => i);

        const posInBucket = bucketIndices.findIndex(
          (i) => prev[i].id === playlistId,
        );
        if (posInBucket < 0) return prev;
        const neighborPos =
          direction === "up" ? posInBucket - 1 : posInBucket + 1;
        if (neighborPos < 0 || neighborPos >= bucketIndices.length) return prev;

        const aIdx = bucketIndices[posInBucket];
        const bIdx = bucketIndices[neighborPos];
        const next = [...prev];
        [next[aIdx], next[bIdx]] = [next[bIdx], next[aIdx]];
        playlistsRef.current = next;
        return next;
      });

      queueRef.current = queueRef.current.then(async () => {
        const current = playlistsRef.current;
        const playlist = current.find((p) => p.id === playlistId);
        let otherId: string | undefined;
        if (playlist) {
          const ownerKey = playlist.watchedUserId ?? "_orphan";
          const bucketIndices = current
            .map((p, i) => ({ p, i }))
            .filter(
              ({ p }) =>
                (p.watchedUserId ?? "_orphan") === ownerKey &&
                p.section === playlist.section,
            )
            .map(({ i }) => i);
          const posInBucket = bucketIndices.findIndex(
            (i) => current[i].id === playlistId,
          );
          // After the optimistic swap, the neighbor that was swapped
          // is now in the direction we came FROM.
          const neighborIdx =
            direction === "up" ? posInBucket + 1 : posInBucket - 1;
          if (neighborIdx >= 0 && neighborIdx < bucketIndices.length) {
            otherId = current[bucketIndices[neighborIdx]].id;
          }
        }
        if (!otherId) return;
        try {
          const res = await fetch("/api/playlists/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ a: playlistId, b: otherId }),
          });
          if (!res.ok) throw new Error(`reorder ${res.status}`);
        } catch {
          // Revert: swap back.
          setPlaylists((prev) => {
            const aIdx = prev.findIndex((p) => p.id === playlistId);
            const bIdx = prev.findIndex((p) => p.id === otherId);
            if (aIdx < 0 || bIdx < 0) return prev;
            const next = [...prev];
            [next[aIdx], next[bIdx]] = [next[bIdx], next[aIdx]];
            playlistsRef.current = next;
            return next;
          });
        }
      });
    },
    [],
  );

  const deletePlaylist = useCallback((playlistId: string) => {
    setPlaylists((prev) => {
      const next = prev.filter((p) => p.id !== playlistId);
      playlistsRef.current = next;
      return next;
    });
    queueRef.current = queueRef.current.then(async () => {
      try {
        const res = await fetch(`/api/playlists/${playlistId}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`delete ${res.status}`);
      } catch {
        // Hard to revert a delete (we lost the row data).
        // A page refresh will restore from DB.
      }
    });
  }, []);

  // Section change. Throws on cap-reached so SectionPicker can surface it.
  const setSection = useCallback(
    async (playlistId: string, target: Section) => {
      // Optimistic update. If the API call throws, revert.
      const prevSection = playlistsRef.current.find((p) => p.id === playlistId)
        ?.section;
      setPlaylists((prev) => {
        const next = prev.map((p) =>
          p.id === playlistId ? { ...p, section: target } : p,
        );
        playlistsRef.current = next;
        return next;
      });
      try {
        const res = await fetch(`/api/playlists/${playlistId}/section`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section: target }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `section ${res.status}`);
        }
      } catch (e) {
        // Revert.
        if (prevSection) {
          setPlaylists((prev) => {
            const next = prev.map((p) =>
              p.id === playlistId
                ? { ...p, section: prevSection as Section }
                : p,
            );
            playlistsRef.current = next;
            return next;
          });
        }
        throw e;
      }
    },
    [],
  );

  if (playlists.length === 0 && initialWatchedUsers.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        No watched users yet. Add a Spotify user above to start.
      </div>
    );
  }

  // Render order: every WatchedUser the server told us about, in
  // creation order, then the orphan bucket (if any).
  const orphanBuckets = grouped.get("_orphan");

  return (
    <>
      {initialWatchedUsers.map((wu, idx) => {
        const buckets = grouped.get(wu.id) ?? {
          main: [],
          new: [],
          other: [],
        };
        const liveMainCount =
          mainCountByWatchedUserId.get(wu.id) ?? wu.mainCount;
        return (
          <WatchedUserGroup
            key={wu.id}
            watchedUser={wu}
            buckets={buckets}
            mainCount={liveMainCount}
            recentByPlaylist={recentByPlaylist}
            weekByPlaylist={weekByPlaylist}
            errorByPlaylist={errorByPlaylist}
            editing={editing}
            onMove={movePlaylist}
            onDelete={deletePlaylist}
            onSection={setSection}
            toolbar={idx === 0 ? toolbar : undefined}
          />
        );
      })}

      {orphanBuckets &&
        (orphanBuckets.main.length > 0 ||
          orphanBuckets.new.length > 0 ||
          orphanBuckets.other.length > 0) && (
          <OrphanGroup
            buckets={orphanBuckets}
            mainCount={mainCountByWatchedUserId.get("_orphan") ?? 0}
            recentByPlaylist={recentByPlaylist}
            weekByPlaylist={weekByPlaylist}
            errorByPlaylist={errorByPlaylist}
            editing={editing}
            onMove={movePlaylist}
            onDelete={deletePlaylist}
            onSection={setSection}
            toolbar={initialWatchedUsers.length === 0 ? toolbar : undefined}
          />
        )}
    </>
  );
}

interface GroupProps {
  buckets: SectionBuckets;
  mainCount: number;
  recentByPlaylist: Record<string, TrackRow[]>;
  weekByPlaylist: Record<string, number>;
  errorByPlaylist: Record<string, string>;
  editing: boolean;
  onMove: (id: string, dir: "up" | "down") => void;
  onDelete: (id: string) => void;
  onSection: (id: string, target: Section) => Promise<void>;
  toolbar?: React.ReactNode;
}

function WatchedUserGroup({
  watchedUser,
  buckets,
  mainCount,
  recentByPlaylist,
  weekByPlaylist,
  errorByPlaylist,
  editing,
  onMove,
  onDelete,
  onSection,
  toolbar,
}: GroupProps & { watchedUser: WatchedUserRow }) {
  const { mutate } = useSWRConfig();
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const res = await fetch(
        `/api/watched-users/${watchedUser.id}/sync`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        skipped?: string;
        cooldownSeconds?: number;
        added?: number;
        truncated?: boolean;
        privacyLocked?: boolean;
      };
      if (body.skipped === "cooldown") {
        throw new Error(
          `Cooldown active — try in ~${body.cooldownSeconds}s.`,
        );
      }
      if (!res.ok) throw new Error(body.error ?? `${res.status}`);
      const base =
        body.added && body.added > 0
          ? `Synced — ${body.added} new playlist${body.added === 1 ? "" : "s"} in New`
          : body.privacyLocked
            ? "Synced — Spotify blocks new-playlist discovery for this user (existing playlists keep tracking)"
            : "Synced — no new playlists";
      setSyncMessage(
        body.truncated ? `${base} (truncated to first 200)` : base,
      );
      // Revalidate the dashboard so the New section populates immediately.
      mutate(DASHBOARD_KEY);

      // If sync brought in new playlists, drain the first-poll queue
      // immediately so they don't sit on "Loading…" until the next cron
      // tick (which is once-per-day on Vercel Hobby). Each batch goes
      // through the rate-limit chokepoint; on 429 we honor the cooldown
      // and resume.
      if (body.added && body.added > 0) {
        await drainPendingPolls((status) => {
          setSyncMessage(`${base} — ${status}`);
        });
        // Final revalidation after drain so all the populated rows show.
        mutate(DASHBOARD_KEY);
        setSyncMessage(`${base} — first-poll done`);
      }
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleDeleteWatchedUser() {
    const confirmed = confirm(
      `Stop watching ${watchedUser.displayName ?? watchedUser.spotifyId}?\n\nTheir playlists will be detached and moved to Other (history preserved).`,
    );
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/watched-users/${watchedUser.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      // Trigger a full page refresh — the optimistic delete would be
      // tricky because we'd have to reflow many playlists into the
      // orphan bucket. A reload is fine for an explicit destructive
      // action.
      window.location.reload();
    } catch (e) {
      alert(`Failed to stop watching: ${e instanceof Error ? e.message : e}`);
    }
  }

  const ownerLabel =
    watchedUser.displayName ?? watchedUser.spotifyId ?? "Unknown";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          {watchedUser.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={watchedUser.imageUrl}
              alt=""
              className="h-7 w-7 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="h-7 w-7 shrink-0 rounded-full bg-neutral-200 dark:bg-neutral-800" />
          )}
          <h2 className="min-w-0 truncate text-xs uppercase tracking-wide text-neutral-500">
            By {ownerLabel}
          </h2>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {syncMessage && (
            <span className="text-spotify">{syncMessage}</span>
          )}
          {syncError && (
            <span className="text-red-600 dark:text-red-400">
              {syncError}
            </span>
          )}
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="rounded border border-neutral-200 px-2 py-0.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {syncing ? "Syncing…" : "Sync"}
          </button>
          {editing && (
            <button
              type="button"
              onClick={handleDeleteWatchedUser}
              className="rounded border border-red-300 px-2 py-0.5 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Stop watching
            </button>
          )}
          {toolbar}
        </div>
      </div>

      {SECTION_ORDER.map((section) => {
        const rows = buckets[section];
        return (
          <SectionList
            key={section}
            section={section}
            rows={rows}
            mainCount={mainCount}
            recentByPlaylist={recentByPlaylist}
            weekByPlaylist={weekByPlaylist}
            errorByPlaylist={errorByPlaylist}
            editing={editing}
            onMove={onMove}
            onDelete={onDelete}
            onSection={onSection}
          />
        );
      })}
    </div>
  );
}

function OrphanGroup(props: GroupProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">
          Pending — added by URL, not yet polled
        </h2>
        {props.toolbar}
      </div>
      {SECTION_ORDER.map((section) => {
        const rows = props.buckets[section];
        return (
          <SectionList
            key={section}
            section={section}
            rows={rows}
            mainCount={props.mainCount}
            recentByPlaylist={props.recentByPlaylist}
            weekByPlaylist={props.weekByPlaylist}
            errorByPlaylist={props.errorByPlaylist}
            editing={props.editing}
            onMove={props.onMove}
            onDelete={props.onDelete}
            onSection={props.onSection}
          />
        );
      })}
    </div>
  );
}

interface SectionListProps {
  section: Section;
  rows: PlaylistRow[];
  mainCount: number;
  recentByPlaylist: Record<string, TrackRow[]>;
  weekByPlaylist: Record<string, number>;
  errorByPlaylist: Record<string, string>;
  editing: boolean;
  onMove: (id: string, dir: "up" | "down") => void;
  onDelete: (id: string) => void;
  onSection: (id: string, target: Section) => Promise<void>;
}

function SectionList({
  section,
  rows,
  mainCount,
  recentByPlaylist,
  weekByPlaylist,
  errorByPlaylist,
  editing,
  onMove,
  onDelete,
  onSection,
}: SectionListProps) {
  // Other is collapsible since it can hold ~50 rows. Default collapsed
  // when non-empty, expanded when empty (so the user sees the empty
  // hint). Main and New always open.
  const collapsible = section === "other";
  const [open, setOpen] = useState(!collapsible || rows.length === 0);

  if (rows.length === 0) {
    // Empty Main or New: render a thin placeholder so the user sees
    // the structure. Empty Other: collapse the heading completely.
    if (section === "other") return null;
    return (
      <div className="space-y-1">
        <SectionHeader
          section={section}
          count={0}
          mainCap={section === "main" ? `0 / ${MAX_MAIN_PER_WATCHED_USER}` : null}
          collapsible={false}
          open={open}
          onToggle={() => setOpen((v) => !v)}
        />
        <div className="rounded-lg border border-dashed border-neutral-200 px-4 py-2 text-xs text-neutral-400 dark:border-neutral-800">
          No playlists in {SECTION_LABELS[section]}.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <SectionHeader
        section={section}
        count={rows.length}
        mainCap={
          section === "main"
            ? `${mainCount} / ${MAX_MAIN_PER_WATCHED_USER}`
            : null
        }
        collapsible={collapsible}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((p, idx) => (
            <PlaylistRowItem
              key={p.id}
              p={p}
              isFirst={idx === 0}
              isLast={idx === rows.length - 1}
              recent={recentByPlaylist[p.id] ?? []}
              weekCount={weekByPlaylist[p.id] ?? 0}
              error={errorByPlaylist[p.id]}
              mainCount={mainCount}
              editing={editing}
              onMove={onMove}
              onDelete={onDelete}
              onSection={onSection}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SectionHeader({
  section,
  count,
  mainCap,
  collapsible,
  open,
  onToggle,
}: {
  section: Section;
  count: number;
  mainCap: string | null;
  collapsible: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const header = (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-400">
        {SECTION_LABELS[section]}
      </span>
      {section === "new" && count > 0 && (
        <span className="rounded-full bg-spotify/20 px-1.5 py-0.5 text-[10px] font-semibold text-spotify">
          {count} to triage
        </span>
      )}
      {section === "other" && count > 0 && (
        <span className="text-[10px] text-neutral-500">({count})</span>
      )}
      {mainCap && (
        <span className="text-[10px] text-neutral-500">{mainCap}</span>
      )}
    </div>
  );
  if (!collapsible) {
    return <div className="px-2 py-0.5">{header}</div>;
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded px-2 py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
    >
      {header}
      <span className="text-[10px] text-neutral-400">
        {open ? "Hide" : "Show"}
      </span>
    </button>
  );
}

interface PlaylistRowItemProps {
  p: PlaylistRow;
  isFirst: boolean;
  isLast: boolean;
  recent: TrackRow[];
  weekCount: number;
  error?: string;
  mainCount: number;
  editing: boolean;
  onMove: (id: string, dir: "up" | "down") => void;
  onDelete: (id: string) => void;
  onSection: (id: string, target: Section) => Promise<void>;
}

function PlaylistRowItem({
  p,
  isFirst,
  isLast,
  recent,
  weekCount,
  error,
  mainCount,
  editing,
  onMove,
  onDelete,
  onSection,
}: PlaylistRowItemProps) {
  const isRateLimited = error?.includes("429");
  return (
    <li className="p-4">
      <div className="flex items-start gap-3">
        {p.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.imageUrl}
            alt=""
            className="h-14 w-14 shrink-0 rounded object-cover"
          />
        ) : (
          <div className="h-14 w-14 shrink-0 rounded bg-neutral-200 dark:bg-neutral-800" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/playlists/${p.id}`}
              className="min-w-0 truncate font-medium hover:underline"
            >
              {p.name === p.spotifyId ? (
                <span className="text-neutral-500">Loading...</span>
              ) : (
                p.name
              )}
            </Link>
            {weekCount > 0 && (
              <span className="shrink-0 rounded-full bg-spotify/20 px-2 py-0.5 text-xs text-spotify">
                +{weekCount} this week
              </span>
            )}
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {p._count.tracks} songs · checked{" "}
            {formatDateTimeJakarta(p.lastCheckedAt)}
            {p.status !== "active" && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                ({p.status})
              </span>
            )}
          </div>
          {error && (
            <div
              className={
                isRateLimited
                  ? "mt-1 break-all rounded bg-amber-100 px-2 py-1 font-mono text-[10px] text-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
                  : "mt-1 break-all rounded bg-red-100 px-2 py-1 font-mono text-[10px] text-red-900 dark:bg-red-950/60 dark:text-red-300"
              }
            >
              {error}
            </div>
          )}
        </div>
        {editing && (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <SectionPicker
              current={(p.section as Section) ?? "main"}
              onChange={(target) => onSection(p.id, target)}
              mainCount={mainCount}
              cap={MAX_MAIN_PER_WATCHED_USER}
            />
            <div className="flex items-center gap-1">
              <RetryButton playlistId={p.id} />
              <PlaylistActions
                playlistName={p.name}
                isFirst={isFirst}
                isLast={isLast}
                onMove={(direction) => onMove(p.id, direction)}
                onDelete={() => onDelete(p.id)}
              />
            </div>
          </div>
        )}
      </div>
      {recent.length > 0 && (
        <ul className="mt-3 space-y-1 border-l border-neutral-200 pl-3 text-xs dark:border-neutral-800">
          {recent.map((t) => {
            const artists = JSON.parse(t.artists) as string[];
            return (
              <li key={t.id} className="flex items-center gap-2">
                {t.albumImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.albumImageUrl}
                    alt=""
                    className="h-6 w-6 shrink-0 rounded-sm object-cover"
                  />
                ) : null}
                <span className="flex-1 truncate">
                  <span className="text-neutral-800 dark:text-neutral-200">
                    {t.title}
                  </span>
                  <span className="text-neutral-500">
                    {" — "}
                    {artists.join(", ")}
                  </span>
                </span>
                <time className="shrink-0 text-neutral-500 dark:text-neutral-600">
                  {formatDateJakarta(t.addedAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
