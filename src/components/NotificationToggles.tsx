"use client";

import { useState } from "react";

interface P {
  id: string;
  name: string;
  notifyEnabled: boolean;
}

export function NotificationToggles({ playlists }: { playlists: P[] }) {
  const [state, setState] = useState(playlists);

  async function toggle(id: string, next: boolean) {
    setState((s) =>
      s.map((p) => (p.id === id ? { ...p, notifyEnabled: next } : p)),
    );
    try {
      const res = await fetch(`/api/playlists/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifyEnabled: next }),
      });
      if (!res.ok) throw new Error(`PATCH ${res.status}`);
    } catch {
      // Revert optimistic update on failure
      setState((s) =>
        s.map((p) => (p.id === id ? { ...p, notifyEnabled: !next } : p)),
      );
    }
  }

  if (state.length === 0) {
    return <p className="text-sm text-neutral-500">No playlists yet.</p>;
  }

  return (
    <ul className="space-y-1">
      {state.map((p) => (
        <li key={p.id} className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={p.notifyEnabled}
            onChange={(e) => toggle(p.id, e.target.checked)}
          />
          <span>{p.name}</span>
        </li>
      ))}
    </ul>
  );
}
