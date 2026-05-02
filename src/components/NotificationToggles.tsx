"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSortModePreference } from "@/lib/sort-mode";
import { WatchedUserAvatar } from "./WatchedUserAvatar";

type Section = "main" | "new" | "other";

const SECTION_ORDER: Section[] = ["main", "new", "other"];
const SECTION_LABEL: Record<Section, string> = {
  main: "Main",
  new: "New",
  other: "Other",
};

interface PlaylistRow {
  id: string;
  name: string;
  imageUrl: string | null;
  notifyEnabled: boolean;
  watchedUserId: string | null;
  section: Section;
  sortOrder: number;
  weekCount: number;
}

interface WatchedUserRow {
  id: string;
  displayName: string | null;
  spotifyId: string;
  imageUrl: string | null;
}

interface Props {
  watchedUsers: WatchedUserRow[];
  playlists: PlaylistRow[];
}

function TriStateCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function NotificationToggles({ watchedUsers, playlists }: Props) {
  const [state, setState] = useState(playlists);
  const [sortMode] = useSortModePreference();

  async function patchOne(id: string, next: boolean) {
    try {
      const res = await fetch(`/api/playlists/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifyEnabled: next }),
      });
      if (!res.ok) throw new Error(`PATCH ${res.status}`);
    } catch {
      setState((s) =>
        s.map((p) => (p.id === id ? { ...p, notifyEnabled: !next } : p)),
      );
    }
  }

  function toggleOne(id: string, next: boolean) {
    setState((s) =>
      s.map((p) => (p.id === id ? { ...p, notifyEnabled: next } : p)),
    );
    patchOne(id, next);
  }

  function toggleMany(ids: string[], next: boolean) {
    const set = new Set(ids);
    setState((s) =>
      s.map((p) => (set.has(p.id) ? { ...p, notifyEnabled: next } : p)),
    );
    for (const id of ids) patchOne(id, next);
  }

  const grouped = useMemo(() => {
    const byWeekly = (a: PlaylistRow, b: PlaylistRow) =>
      b.weekCount - a.weekCount || a.sortOrder - b.sortOrder;
    const byManual = (a: PlaylistRow, b: PlaylistRow) =>
      a.sortOrder - b.sortOrder;
    const sortFn = sortMode === "weekly" ? byWeekly : byManual;

    const out = new Map<string, Map<Section, PlaylistRow[]>>();
    for (const p of state) {
      const userKey = p.watchedUserId ?? "_orphan";
      if (!out.has(userKey)) out.set(userKey, new Map());
      const userMap = out.get(userKey)!;
      if (!userMap.has(p.section)) userMap.set(p.section, []);
      userMap.get(p.section)!.push(p);
    }
    for (const userMap of out.values()) {
      for (const arr of userMap.values()) arr.sort(sortFn);
    }
    return out;
  }, [state, sortMode]);

  if (state.length === 0) {
    return <p className="text-sm text-neutral-500">No playlists yet.</p>;
  }

  const userOrder: { key: string; user: WatchedUserRow | null }[] = [
    ...watchedUsers
      .filter((wu) => grouped.has(wu.id))
      .map((wu) => ({ key: wu.id, user: wu })),
    ...(grouped.has("_orphan") ? [{ key: "_orphan", user: null }] : []),
  ];

  return (
    <div className="space-y-3">
      {userOrder.map(({ key, user }) => {
        const userMap = grouped.get(key);
        if (!userMap) return null;
        const allUserPlaylists = Array.from(userMap.values()).flat();
        if (allUserPlaylists.length === 0) return null;
        const userOnCount = allUserPlaylists.filter(
          (p) => p.notifyEnabled,
        ).length;
        const userAllOn = userOnCount === allUserPlaylists.length;
        const userNoneOn = userOnCount === 0;
        const userLabel = user
          ? user.displayName ?? user.spotifyId
          : "Pending";

        return (
          <div
            key={key}
            className="rounded-lg border border-neutral-200 dark:border-neutral-800"
          >
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <TriStateCheckbox
                checked={userAllOn}
                indeterminate={!userAllOn && !userNoneOn}
                onChange={(next) =>
                  toggleMany(
                    allUserPlaylists.map((p) => p.id),
                    next,
                  )
                }
                ariaLabel={`Toggle all ${userLabel} playlists`}
              />
              {user ? (
                <WatchedUserAvatar
                  imageUrl={user.imageUrl}
                  displayName={user.displayName}
                  spotifyId={user.spotifyId}
                  size="sm"
                />
              ) : null}
              <span className="text-sm font-medium">{userLabel}</span>
              <span className="text-[10px] text-neutral-400">
                ({userOnCount}/{allUserPlaylists.length})
              </span>
            </div>
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {SECTION_ORDER.filter((s) => (userMap.get(s)?.length ?? 0) > 0).map(
                (section) => {
                  const sectionPlaylists = userMap.get(section)!;
                  const ids = sectionPlaylists.map((p) => p.id);
                  const onCount = sectionPlaylists.filter(
                    (p) => p.notifyEnabled,
                  ).length;
                  const allOn = onCount === sectionPlaylists.length;
                  const noneOn = onCount === 0;
                  return (
                    <div key={section} className="space-y-1 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <TriStateCheckbox
                          checked={allOn}
                          indeterminate={!allOn && !noneOn}
                          onChange={(next) => toggleMany(ids, next)}
                          ariaLabel={`Toggle all ${SECTION_LABEL[section]} playlists for ${userLabel}`}
                        />
                        <span className="text-[10px] text-neutral-400">
                          {SECTION_LABEL[section]} ({onCount}/
                          {sectionPlaylists.length})
                        </span>
                      </div>
                      <ul className="ml-6 space-y-1">
                        {sectionPlaylists.map((p) => (
                          <li
                            key={p.id}
                            className="flex items-center gap-2 text-sm"
                          >
                            <input
                              type="checkbox"
                              checked={p.notifyEnabled}
                              onChange={(e) =>
                                toggleOne(p.id, e.target.checked)
                              }
                              aria-label={`Toggle ${p.name}`}
                            />
                            {p.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={p.imageUrl}
                                alt=""
                                className="h-8 w-8 shrink-0 rounded object-cover"
                              />
                            ) : (
                              <div className="h-8 w-8 shrink-0 rounded bg-neutral-200 dark:bg-neutral-800" />
                            )}
                            <span className="truncate">{p.name}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
