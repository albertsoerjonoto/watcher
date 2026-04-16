# Watcher

Phase 1 web app that monitors Spotify playlists and pushes a notification to
your phone every time a new track is added. Built with Next.js 14 (App
Router) + Prisma (SQLite) + Web Push. iOS Safari is supported once the app
is "Added to Home Screen".

Phase 2 (native SwiftUI iOS client that reuses this backend) is intentionally
deferred — the DB already has a `DeviceToken` table so the dispatcher can fan
out to APNs later without schema changes.

---

## Quickstart

### 1. Install

```sh
npm install
```

### 2. Create a Spotify app

1. Go to <https://developer.spotify.com/dashboard> and create an app.
2. Under **Redirect URIs**, add:
   - `http://localhost:3000/api/auth/callback` (for local)
   - `https://<your-deployment>/api/auth/callback` (for prod)
3. Copy the **Client ID** — we use PKCE, so you do **not** need the client
   secret.

### 3. Generate VAPID keys

```sh
npx web-push generate-vapid-keys
```

Copy `publicKey` into both `VAPID_PUBLIC_KEY` and
`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, and `privateKey` into `VAPID_PRIVATE_KEY`.

### 4. Env file

```sh
cp .env.example .env
```

Fill in:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_REDIRECT_URI`
- `SESSION_SECRET` — any long random string
- `CRON_SECRET` — any long random string
- `VAPID_*` keys
- `DATABASE_URL=file:./dev.db` (already set)

### 5. Database

```sh
npx prisma db push   # creates dev.db from schema
```

### 6. Run

```sh
npm run dev
```

Open <http://localhost:3000>, click **Sign in with Spotify**, then paste a
playlist URL into the dashboard. The first fetch seeds the baseline (silently
— no notifications for the initial track list).

### 7. Seed from playlists.json (optional)

After you sign in once, run:

```sh
npm run db:seed
```

This reads `playlists.json` and creates `Playlist` rows for the matching
owner. Run `npm run poll` to backfill tracks for the seeded playlists.

> ⚠️ `playlists.json` contains a known collision: *My Playlist #66* and
> *Be With You* share `58dAusOvMGNqwvTwCLu7FF`. Fix the second ID before
> seeding.

### 8. Cron

- **Vercel**: `vercel.json` already contains `"*/10 * * * *"` pointing at
  `/api/cron/poll`. Vercel sets `x-vercel-cron`, which the endpoint trusts.
- **GitHub Action / anything else**:

  ```yaml
  - run: curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
           https://your.app/api/cron/poll
  ```

The endpoint is idempotent — concurrent runs and retries are safe.

---

## How notifications work end-to-end

1. You sign in with Spotify.
2. You click **Enable on this device** in Settings. The browser registers
   `/sw.js`, requests Notification permission, creates a PushManager
   subscription with the VAPID public key, and POSTs it to
   `/api/push/subscribe`.
3. The cron endpoint polls each watched playlist. A cheap
   `GET /playlists/{id}` is compared against `snapshotId`; if unchanged, it
   short-circuits.
4. If changed, the cron fetches all tracks, diffs against the DB, inserts new
   rows, and for each new track fans out a web-push notification to every
   subscription owned by the user — **except** tracks added by the user
   themselves (owner-filter), so you don't get notified about your own adds.
5. Tapping the notification opens the track on Spotify.

### Verifying push end-to-end on iPhone

1. Deploy to a real HTTPS origin. iOS Safari requires TLS.
2. Open the deployed site in Safari on iOS 16.4+.
3. Tap the Share icon → **Add to Home Screen**. Open the app from the home
   screen icon — **not** the Safari tab. Web push only works from the
   installed PWA on iOS.
4. Sign in. Go to Settings → **Enable on this device** → allow.
5. Tap **Send test**. You should see a notification within a second or two.
6. To verify the end-to-end real flow, manually add a track to one of your
   watched playlists, then hit `/api/cron/poll` with your CRON_SECRET (or
   wait for the next scheduled run).

---

## Architecture

```
src/
├─ app/
│  ├─ api/
│  │  ├─ auth/{login,callback,logout}/route.ts    Spotify OAuth (PKCE)
│  │  ├─ playlists/route.ts                       GET list / POST add
│  │  ├─ playlists/[id]/route.ts                  DELETE / PATCH
│  │  ├─ push/{vapid,subscribe}/route.ts          Web Push registration
│  │  └─ cron/poll/route.ts                       Secret-guarded poll-all
│  ├─ page.tsx              Dashboard
│  ├─ feed/page.tsx         Cross-playlist chronological feed
│  ├─ playlists/[id]/page.tsx
│  └─ settings/page.tsx
├─ components/
│  ├─ AddPlaylistForm.tsx
│  ├─ EnablePush.tsx        Service-worker registration + subscribe
│  ├─ InstallHint.tsx       iOS "Add to Home Screen" banner
│  └─ NotificationToggles.tsx
└─ lib/
   ├─ db.ts          Prisma client singleton
   ├─ diff.ts        ** critical path — unit-tested **
   ├─ spotify.ts     Token refresh, rate-limit, paginated track fetch
   ├─ pkce.ts
   ├─ session.ts     HMAC-signed session cookie
   ├─ push.ts        web-push dispatcher (prunes dead subs)
   └─ poll.ts        Per-playlist poll + snapshot short-circuit
```

### Key design decisions

- **`(spotifyTrackId, addedAt)` is the track identity** inside a playlist,
  not `spotifyTrackId` alone. Spotify lets you add a song to a playlist
  multiple times; we want each re-add to count as a new event.
- **`snapshot_id` short-circuit.** The first call per playlist is a tiny
  metadata fetch; full track pagination only runs when `snapshot_id`
  changes. This keeps the polling footprint essentially free.
- **First-seed silence.** When a playlist is first added, `snapshotId` is
  null; the poll fills the DB but suppresses notifications. No spam.
- **Owner-filter.** Tracks where `added_by.id === user.spotifyId` are
  filtered out before dispatch — you don't get notified about songs you
  added yourself.
- **Idempotent cron.** `(playlistId, spotifyTrackId, addedAt)` is the unique
  key, so concurrent or retried runs can't double-insert.

## Tests

```sh
npm test
```

Covers the diff logic (critical path) and `parsePlaylistId`.

## Deployment notes

- **SQLite on Vercel** only works if you use Vercel's `/tmp`-style ephemeral
  storage for local dev; for production, swap the Prisma datasource to
  Postgres (Neon / Supabase). Change `provider = "postgresql"` in
  `prisma/schema.prisma` and re-run `npx prisma db push`.
- Set env vars in the Vercel project: all of `.env.example` minus
  `DATABASE_URL` (use the Postgres URL instead).

## Phase 2 — iOS native app (not yet implemented)

Sketch for when we get to it:

- SwiftUI + iOS 17.
- Same Spotify PKCE flow, deep-linked via `watcher://callback`.
- APNs token posted to `/api/devices` (route to add), stored in
  `DeviceToken` table. The dispatcher in `src/lib/push.ts` is structured so
  APNs fan-out can slot in next to web push with no schema changes.
- Lock Screen + Home Screen widgets reading the same `/api/feed` surface.
- Live Activities for "N tracks added to {playlist} just now" bursts.

Backend changes required:

- Add `POST /api/devices` + signed request check.
- Add an `apns` branch in `sendPushToUser` using `node-apn`.
- Split API from UI pages (or add a `/api/v1` prefix) so the Swift client
  has a stable surface.
