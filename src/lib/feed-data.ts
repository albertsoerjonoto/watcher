// Shared feed data loader. Used by both:
//   - SSR fallback in src/app/feed/page.tsx (instant first paint)
//   - SWR JSON in src/app/api/feed/route.ts (background revalidate)
//
// Mirrors the dashboard-data.ts pattern. Pure DB reads — never calls
// Spotify. Serialises addedAt to ISO string for JSON-safety on the wire.

import { Prisma } from "@prisma/client";
import { prisma } from "./db";

export type FeedFilter = "all" | "main" | "new" | "other";

export interface FeedRow {
  id: string;
  title: string;
  artists: string;
  albumImageUrl: string | null;
  addedAt: string; // ISO
  playlistId: string;
  playlistName: string;
  playlistImageUrl: string | null;
  section: string;
  spotifyTrackId: string;
}

export interface FeedData {
  filter: FeedFilter;
  events: FeedRow[];
}

interface RawFeedRow extends Omit<FeedRow, "addedAt"> {
  addedAt: Date;
}

export function parseFeedFilter(
  raw: string | string[] | undefined,
): FeedFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "main" || v === "new" || v === "other") return v;
  return "all";
}

export async function loadFeedData(
  userId: string,
  filter: FeedFilter,
): Promise<FeedData> {
  const sectionClause =
    filter === "all" ? Prisma.empty : Prisma.sql`AND p."section" = ${filter}`;
  const rows = await prisma.$queryRaw<RawFeedRow[]>(Prisma.sql`
    SELECT t.id, t.title, t.artists, t."albumImageUrl", t."addedAt", t."spotifyTrackId",
           p.id AS "playlistId", p.name AS "playlistName",
           p."imageUrl" AS "playlistImageUrl", p."section" AS "section"
    FROM "Track" t
    JOIN "Playlist" p ON t."playlistId" = p.id
    WHERE p."userId" = ${userId}
      AND t."addedAt" >= p."createdAt"
      ${sectionClause}
    ORDER BY t."addedAt" DESC
    LIMIT 200
  `);

  const events: FeedRow[] = rows.map((r) => ({
    ...r,
    addedAt:
      r.addedAt instanceof Date ? r.addedAt.toISOString() : String(r.addedAt),
  }));

  return { filter, events };
}
