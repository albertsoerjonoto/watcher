// Direct DB inspector for the production Postgres. Read-only by
// default — useful for spot checks the /api/qa/probe aggregate
// endpoint can't cover (e.g. "is THIS specific user's avatar still
// set?", "did the last poll for THIS playlist actually persist new
// tracks?").
//
//   npm run qa:db                  # smoke summary (counts + flags)
//   npm run qa:db -- watched       # WatchedUser rows: id, displayName, imageUrl, lastSyncedAt
//   npm run qa:db -- recent-polls  # last 20 PollLog rows
//   npm run qa:db -- errors        # most-recent PollLog rows that errored
//
// Reads DATABASE_URL from env. Lazy migration runs automatically via
// the Prisma client extension in src/lib/db.ts, so a fresh connection
// from this script will apply additive migrations exactly like the
// app does. Read-only — no schema mutations, no data writes.

import { prisma } from "../src/lib/db";

interface Subcmd {
  description: string;
  run: () => Promise<void>;
}

const subcmds: Record<string, Subcmd> = {
  smoke: {
    description: "row counts + recent activity summary",
    run: async () => {
      const [users, watched, playlists, tracks, polls] = await Promise.all([
        prisma.user.count(),
        prisma.watchedUser.count(),
        prisma.playlist.count(),
        prisma.track.count(),
        prisma.pollLog.count(),
      ]);
      const lastPoll = await prisma.pollLog.findFirst({
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, error: true },
      });
      const stuckAvatars = await prisma.watchedUser.count({
        where: { imageUrl: null },
      });
      console.log(
        `users=${users} watched=${watched} playlists=${playlists} tracks=${tracks} polls=${polls}`,
      );
      console.log(`watchedUsers with null imageUrl: ${stuckAvatars}`);
      if (lastPoll) {
        const age = Math.round(
          (Date.now() - lastPoll.startedAt.getTime()) / 60000,
        );
        console.log(
          `last poll: ${age}m ago${lastPoll.error ? ` (errored: ${lastPoll.error.slice(0, 80)})` : ""}`,
        );
      } else {
        console.log("no PollLog rows");
      }
    },
  },

  watched: {
    description: "WatchedUser rows summary",
    run: async () => {
      const rows = await prisma.watchedUser.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          spotifyId: true,
          displayName: true,
          imageUrl: true,
          lastSyncedAt: true,
        },
      });
      for (const r of rows) {
        console.log(
          `  ${r.spotifyId.padEnd(28)} display=${r.displayName ?? "?"}  imageUrl=${r.imageUrl ? "set" : "NULL"}  lastSync=${r.lastSyncedAt ? `${Math.round((Date.now() - r.lastSyncedAt.getTime()) / 60000)}m ago` : "never"}`,
        );
      }
    },
  },

  "recent-polls": {
    description: "last 20 PollLog rows",
    run: async () => {
      const rows = await prisma.pollLog.findMany({
        orderBy: { startedAt: "desc" },
        take: 20,
        select: {
          startedAt: true,
          durationMs: true,
          newTracks: true,
          error: true,
          playlistId: true,
        },
      });
      for (const r of rows) {
        const age = Math.round(
          (Date.now() - r.startedAt.getTime()) / 60000,
        );
        console.log(
          `  ${age.toString().padStart(4)}m  ${r.durationMs.toString().padStart(5)}ms  +${r.newTracks}  ${r.error ? `ERR ${r.error.slice(0, 80)}` : "ok"}`,
        );
      }
    },
  },

  errors: {
    description: "most recent errored polls",
    run: async () => {
      const rows = await prisma.pollLog.findMany({
        where: { error: { not: null } },
        orderBy: { startedAt: "desc" },
        take: 10,
        select: {
          startedAt: true,
          error: true,
          playlistId: true,
        },
      });
      if (rows.length === 0) {
        console.log("no errored polls");
        return;
      }
      for (const r of rows) {
        const age = Math.round(
          (Date.now() - r.startedAt.getTime()) / 60000,
        );
        console.log(`  ${age}m ago  playlist=${r.playlistId ?? "?"}  ${r.error}`);
      }
    },
  },
};

const sub = process.argv[2] ?? "smoke";
const cmd = subcmds[sub];
if (!cmd) {
  console.error(
    `unknown: ${sub}\noptions:\n${Object.entries(subcmds)
      .map(([k, v]) => `  ${k.padEnd(14)} ${v.description}`)
      .join("\n")}`,
  );
  process.exit(1);
}

cmd
  .run()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
