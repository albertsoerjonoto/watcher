"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { DASHBOARD_KEY } from "./DashboardContent";

export function RetryButton({ playlistId }: { playlistId: string }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      await fetch(`/api/playlists/${playlistId}/retry`, { method: "POST" });
    } finally {
      setBusy(false);
      mutate(DASHBOARD_KEY);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {busy ? "Retrying…" : "Retry"}
    </button>
  );
}
