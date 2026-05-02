# Deploying Watcher

This guide is the exact, minimum click list to get phone notifications
working. I can't click the buttons for you — they're all tied to your
personal accounts — but everything in this repo is already configured for
this path.

Target stack: **Vercel** (hosting + cron) + **Neon** (free serverless Postgres) +
your existing **Spotify Developer** app.

Time: ~10 minutes end-to-end, assuming GitHub, Vercel, and Neon
accounts are already logged in.

---

## 1. Create a Neon Postgres database

1. Go to <https://neon.tech> → sign up (GitHub OAuth works) → **New Project**.
2. Name it `watcher`, pick a region close to your Vercel deployment.
3. Once created, copy the **connection string** from the dashboard.
   It looks like:

   ```
   postgresql://[user]:[password]@[endpoint].neon.tech/neondb?sslmode=require
   ```

   Keep this tab open — you'll paste this into Vercel in a moment.

---

## 2. Import the repo into Vercel

1. Go to <https://vercel.com/new>.
2. **Import** the `albertsoerjonoto/watcher` repo.
3. On the configure screen:
   - **Framework**: Next.js (auto-detected)
   - **Root Directory**: leave as repo root
   - **Build Command**: leave default (`prisma generate && next build`).
     The build does NOT run `prisma db push` — Vercel doesn't expose
     `DATABASE_URL` to the build phase by default, so additive
     migrations are applied at runtime via the Prisma client extension
     in `src/lib/db.ts`. See `CLAUDE.md` → "Schema migrations".
   - **Production Branch**: leave as `main` (the default).
4. Expand **Environment Variables** and set the following keys. Use
   the values you generate yourself — do NOT commit any of them back
   to this file:

   | Key | Source / how to generate |
   |---|---|
   | `SPOTIFY_CLIENT_ID` | from your Spotify app dashboard |
   | `SPOTIFY_REDIRECT_URI` | `https://<will-fill-after-deploy>/api/auth/callback` |
   | `APP_BASE_URL` | `https://<will-fill-after-deploy>` |
   | `SESSION_SECRET` | `openssl rand -base64 32` |
   | `DATABASE_URL` | Neon connection string from step 1 |
   | `CRON_SECRET` | `openssl rand -base64 32` |
   | `VAPID_PUBLIC_KEY` | run `npx web-push generate-vapid-keys` and paste the public key |
   | `VAPID_PRIVATE_KEY` | from the same `generate-vapid-keys` run |
   | `VAPID_SUBJECT` | `mailto:your-email@example.com` |
   | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | same value as `VAPID_PUBLIC_KEY` |

   > Leave `SPOTIFY_REDIRECT_URI` and `APP_BASE_URL` with the placeholder
   > for now — you'll update them in step 4 once Vercel assigns a URL.

   > **Security note.** Earlier revisions of this file pasted the live
   > production values for `SESSION_SECRET`, `CRON_SECRET`, and the
   > VAPID keypair directly in the table. They're in this repo's git
   > history. If those are still your active production values, rotate
   > all three before considering them private. See `SECURITY.md`.

5. Click **Deploy**. Wait ~90 seconds. The first deploy will leave
   your Neon DB empty — run `npm run db:push` once locally (with the
   Neon `DATABASE_URL` exported in your shell) to create the tables.
   After that, additive schema changes apply themselves on first
   request via `src/lib/db.ts` (see `CLAUDE.md` → "Schema migrations").

---

## 3. Grab the deployed URL

After the build finishes, Vercel shows you a URL like:

```
https://watcher-<hash>.vercel.app
```

…or the nicer production alias:

```
https://watcher.vercel.app
```

Copy whichever one is your stable production URL.

---

## 4. Patch the env vars with the real URL

In the Vercel project → **Settings → Environment Variables**:

- Edit `SPOTIFY_REDIRECT_URI` → set to `https://<your-url>/api/auth/callback`
- Edit `APP_BASE_URL` → set to `https://<your-url>`
- Save → click **Deployments → … → Redeploy** on the latest one to pick
  up the new values.

---

## 5. Add the production redirect URI to your Spotify app

1. <https://developer.spotify.com/dashboard> → **Claude Code Testing** → **Settings**.
2. Under **Redirect URIs**, click **Add**, paste:

   ```
   https://<your-vercel-url>/api/auth/callback
   ```

3. Scroll down to **Save**. Spotify won't let OAuth work from a URL that
   isn't registered.

**Also — still in Development mode**: go to the **User Management** tab
and add your own Spotify account (name + email the account is registered
with). Without this, Spotify will refuse to log you in.

---

## 6. Verify on your iPhone

1. On your iPhone, open Safari and go to `https://<your-vercel-url>`.
2. Tap **Share → Add to Home Screen**. Open the app from the home-screen
   icon — **not** the Safari tab. iOS web push only works from the
   installed PWA.
3. Tap **Sign in with Spotify** → approve → you land on the dashboard.
4. Go to **Settings** → **Enable on this device** → allow notifications.
5. Tap **Send test**. A push should land within a couple of seconds.

If the test works, you're done. The Vercel cron runs every 10 minutes
(`vercel.json` already has this wired up). Add a playlist URL from the
dashboard and the next time anyone adds a track, you'll get a ping.

---

## Troubleshooting

**"User not registered in the Developer Dashboard"**
→ You skipped User Management in step 5. Go add yourself.

**"INVALID_CLIENT: Invalid redirect URI"**
→ Your `SPOTIFY_REDIRECT_URI` env var and the URI registered in the
Spotify dashboard aren't byte-identical. Trailing slash, http vs https,
a typo in the hostname — all count.

**Build fails with `Error: P1001: Can't reach database server`**
→ The Neon connection string is wrong. Most common causes:
1. The connection string was copy-pasted incorrectly.
2. The Neon project was suspended (free tier auto-suspends after 5 min
   of inactivity, but wakes on connection — just retry the build).
3. `sslmode=require` is missing from the connection string.

**Build fails with `prisma db push` saying drift detected**
→ Someone (you? a previous deploy?) modified the DB schema out-of-band.
Safe fix: in the Neon SQL Editor, run `DROP SCHEMA public CASCADE;
CREATE SCHEMA public;`, then redeploy.

**Notifications don't arrive on iPhone**
1. You must have opened the app **from the home-screen icon**, not Safari.
2. Notification permission must be granted (Settings → Notifications →
   Watcher on iOS).
3. Hit **Send test** in the app's Settings — if that works but real
   notifications don't, trigger the cron manually:

   ```
   curl -H "Authorization: Bearer 1Xabh5Se7O5tFirfC6joj56u4OjYQY0GFD5wEOP9XFk" \
     https://<your-vercel-url>/api/cron/poll
   ```

**Want to manually trigger a poll**
`curl -H "Authorization: Bearer $CRON_SECRET" https://<url>/api/cron/poll`

---

## What lives where

- **Code** — this repo, branch `main`
- **DB** — Neon (serverless Postgres, free tier)
- **Host + cron** — Vercel (`vercel.json` defines `*/10 * * * *`)
- **Auth** — Spotify Developer app (`Claude Code Testing`)
- **Push** — VAPID keys in Vercel env + service worker in
  `public/sw.js`
