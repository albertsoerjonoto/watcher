// Seed script: reads playlists.json and creates Playlist rows for the most
// recently signed-in user whose spotifyId matches `owner`. Does NOT fetch
// tracks — run the cron once after seeding to backfill and set snapshotId
// (backfill suppresses notifications via the isFirstSeed guard).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface Seed {
  owner: string;
  playlists: { name: string; spotifyId: string; _note?: string }[];
}

async function main() {
  const path = resolve(process.cwd(), "playlists.json");
  const seed = JSON.parse(readFileSync(path, "utf8")) as Seed;

  const user = await prisma.user.findUnique({
    where: { spotifyId: seed.owner },
  });
  if (!user) {
    console.error(
      `No user with spotifyId=${seed.owner} exists. Sign in via the web app first, then re-run the seed.`,
    );
    process.exit(1);
  }

  for (const p of seed.playlists) {
    if (p._note) console.warn(`⚠️  ${p.name}: ${p._note}`);
    const created = await prisma.playlist.upsert({
      where: {
        userId_spotifyId: { userId: user.id, spotifyId: p.spotifyId },
      },
      update: { name: p.name },
      create: {
        userId: user.id,
        name: p.name,
        spotifyId: p.spotifyId,
      },
    });
    console.log(`seeded ${created.name} (${created.spotifyId})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
