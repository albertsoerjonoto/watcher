"use client";

import { useState } from "react";

// Tailwind-known background colors. Listed explicitly so the JIT compiler
// keeps them in the bundle (interpolated class names get tree-shaken).
const BG_PALETTE = [
  "bg-rose-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-pink-500",
  "bg-teal-500",
  "bg-indigo-500",
] as const;

function pickColor(seed: string): string {
  // Cheap deterministic hash → palette index. Same seed always picks the
  // same color, so the avatar identity is stable across renders.
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return BG_PALETTE[Math.abs(hash) % BG_PALETTE.length];
}

function pickInitial(displayName: string | null, fallback: string): string {
  const source = (displayName?.trim() ?? fallback).trim();
  // Strip leading non-letters (so "@nick" → "N", "1234" → "1").
  const firstChar = source.charAt(0);
  return firstChar.toUpperCase() || "?";
}

interface Props {
  imageUrl: string | null;
  displayName: string | null;
  spotifyId: string | null;
  size?: "sm" | "md";
  className?: string;
}

export function WatchedUserAvatar({
  imageUrl,
  displayName,
  spotifyId,
  size = "md",
  className,
}: Props) {
  // Track image-load failures so a broken URL falls back to initials.
  const [imageFailed, setImageFailed] = useState(false);

  const sizeClasses = size === "sm" ? "h-7 w-7 text-xs" : "h-8 w-8 text-sm";
  const baseClass = `${sizeClasses} shrink-0 rounded-full ${className ?? ""}`;
  const seed = spotifyId ?? displayName ?? "?";
  const initial = pickInitial(displayName, spotifyId ?? "?");
  const bg = pickColor(seed);

  if (imageUrl && !imageFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        className={`${baseClass} object-cover`}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <div
      className={`${baseClass} ${bg} flex items-center justify-center font-semibold text-white`}
      aria-label={displayName ?? spotifyId ?? "user"}
    >
      {initial}
    </div>
  );
}
