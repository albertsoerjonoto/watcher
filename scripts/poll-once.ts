// Manual poll runner — useful for local testing without setting up cron.
//
//   pnpm poll                # poll all users
//   pnpm poll <spotifyId>    # poll just one
//
// Writes PollLog rows just like the HTTP cron endpoint.

import { PrismaClient } from "@prisma/client";
import { pollAllForUser } from "../src/lib/poll";

const prisma = new PrismaClient();

async function main() {
  const target = process.argv[2];
  const users = await prisma.user.findMany({
    where: target ? { spotifyId: target } : undefined,
  });
  for (const u of users) {
    console.log(`polling for ${u.spotifyId}…`);
    const results = await pollAllForUser(u);
    for (const r of results) {
      console.log(
        `  ${r.playlistId} skipped=${r.skipped} new=${r.newTracks} notified=${r.notified}${r.error ? " err=" + r.error : ""}`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
