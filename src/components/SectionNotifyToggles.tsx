"use client";

import { useState } from "react";

type Section = "main" | "new" | "other";

interface Flags {
  notifyMain: boolean;
  notifyNew: boolean;
  notifyOther: boolean;
}

const FIELD_BY_SECTION: Record<Section, keyof Flags> = {
  main: "notifyMain",
  new: "notifyNew",
  other: "notifyOther",
};

const LABEL_BY_SECTION: Record<Section, string> = {
  main: "Main",
  new: "New",
  other: "Other",
};

export function SectionNotifyToggles({ initial }: { initial: Flags }) {
  const [state, setState] = useState<Flags>(initial);

  async function toggle(section: Section, next: boolean) {
    const field = FIELD_BY_SECTION[section];
    setState((s) => ({ ...s, [field]: next }));
    try {
      const res = await fetch("/api/settings/notify", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) throw new Error(`PATCH ${res.status}`);
    } catch {
      setState((s) => ({ ...s, [field]: !next }));
    }
  }

  return (
    <ul className="space-y-1">
      {(Object.keys(LABEL_BY_SECTION) as Section[]).map((section) => {
        const field = FIELD_BY_SECTION[section];
        return (
          <li key={section} className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={state[field]}
              onChange={(e) => toggle(section, e.target.checked)}
            />
            <span>{LABEL_BY_SECTION[section]}</span>
          </li>
        );
      })}
    </ul>
  );
}
