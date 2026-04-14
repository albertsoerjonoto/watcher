"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RetryButton({ playlistId }: { playlistId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      await fetch(`/api/playlists/${playlistId}/retry`, { method: "POST" });
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
    >
      {busy ? "Retrying…" : "Retry"}
    </button>
  );
}
