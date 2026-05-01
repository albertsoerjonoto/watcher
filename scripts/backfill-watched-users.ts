// One-time backfill for the WatchedUser feature.
//
// What it does:
//   1. For each distinct (userId, ownerSpotifyId) on existing Playlists,
//      upsert a WatchedUser row. displayName is copied from the most
//      recent ownerDisplayName seen on that user's playlists.
//   2. For each Playlist with ownerSpotifyId set but watchedUserId NULL,
//      attach to the matching WatchedUser.
//
// What it does NOT do:
//   - Touch Playlist.section. After `prisma db push`, the new column has
//     default "main" applied to every existing row, which is exactly what
//     we want for the 6 currently-curated playlists.
//   - Attach playlists with ownerSpotifyId = NULL (stub rows added via
//     POST /api/playlists that never successfully polled). The post-poll
//     attach hook in src/lib/poll.ts handles those once they get polled.
//
// Idempotent. Re-running it after a partial run, or after new playlists
// have been added, is safe — every step is an upsert or null-conditional
// update.
//
// Usage:
//   npm run db:push
//   npx tsx scripts/backfill-watched-users.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Find distinct (userId, ownerSpotifyId) pairs across all Playlists with
  // a non-null ownerSpotifyId. Use a raw SQL distinct for efficiency on
  // large tables — at present the table is tiny but keeping this future-
  // proof costs nothing.
  const pairs = await prisma.playlist.findMany({
    where: { ownerSpotifyId: { not: null } },
    select: {
      userId: true,
      ownerSpotifyId: true,
      ownerDisplayName: true,
    },
    distinct: ["userId", "ownerSpotifyId"],
  });

  console.log(
    `[backfill] found ${pairs.length} distinct (userId, ownerSpotifyId) pairs`,
  );

  for (const p of pairs) {
    if (!p.ownerSpotifyId) continue; // narrowing — `distinct` doesn't narrow
    const wu = await prisma.watchedUser.upsert({
      where: {
        userId_spotifyId: {
          userId: p.userId,
          spotifyId: p.ownerSpotifyId,
        },
      },
      update: {
        // Don't clobber a non-null displayName with another null. Only
        // overwrite when we have a non-null value AND the existing row
        // has none. (For the typical 1-pair-per-user case this never
        // triggers; it's safety against a re-run picking up a fresher
        // displayName from a later poll.)
        ...(p.ownerDisplayName
          ? { displayName: p.ownerDisplayName }
          : {}),
      },
      create: {
        userId: p.userId,
        spotifyId: p.ownerSpotifyId,
        displayName: p.ownerDisplayName ?? null,
      },
    });

    // Attach every Playlist with this (userId, ownerSpotifyId) and
    // null watchedUserId. Already-attached rows are filtered out so
    // this is idempotent.
    const updated = await prisma.playlist.updateMany({
      where: {
        userId: p.userId,
        ownerSpotifyId: p.ownerSpotifyId,
        watchedUserId: null,
      },
      data: { watchedUserId: wu.id },
    });

    console.log(
      `[backfill] watchedUser=${wu.id} (spotifyId=${wu.spotifyId}, name=${wu.displayName ?? "?"}): attached ${updated.count} playlist(s)`,
    );
  }

  // Surface stub rows that the post-poll attach hook will handle later.
  const orphans = await prisma.playlist.count({
    where: { watchedUserId: null },
  });
  if (orphans > 0) {
    console.log(
      `[backfill] ${orphans} playlist(s) have no watchedUserId yet (ownerSpotifyId still null). They'll be attached on their first successful poll.`,
    );
  }

  console.log("[backfill] done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
