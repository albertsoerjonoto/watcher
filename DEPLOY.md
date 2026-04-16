# Deploying Watcher

This guide is the exact, minimum click list to get phone notifications
working. I can't click the buttons for you — they're all tied to your
personal accounts — but everything in this repo is already configured for
this path.

Target stack: **Vercel** (hosting + cron) + **Supabase** (free Postgres) +
your existing **Spotify Developer** app.

Time: ~10 minutes end-to-end, assuming GitHub, Vercel, and Supabase
accounts are already logged in.

---

## 1. Create a Supabase Postgres database

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Pick a region close to you, set a **Database Password** (save it —
   you'll paste it in the next step), wait ~1 min for it to provision.
3. Once it's up, click **`Connect`** at the top of the project page.
4. Pick **Session pooler** — port `5432`. Language = `URI`.
   Do *not* use Transaction pooler (port 6543) — PgBouncer in transaction
   mode breaks Prisma's `db push`/`migrate` because they need
   session-level DDL. Session pooler works for both runtime and
   migrations and is more than fine for a single-user app.
5. The template looks like:

   ```
   postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-1-<region>.pooler.supabase.com:5432/postgres
   ```

   Replace `[YOUR-PASSWORD]` with the password you set in step 2.

   > **Tip:** pick a password that's only letters + digits. Special
   > characters like `@ : / # ?` break URL parsing unless URL-encoded.

   Keep this tab open — you'll paste this into Vercel in a moment.

---

## 2. Import the repo into Vercel

1. Go to <https://vercel.com/new>.
2. **Import** the `albertsoerjonoto/watcher` repo.
3. On the configure screen:
   - **Framework**: Next.js (auto-detected)
   - **Root Directory**: leave as repo root
   - **Build Command**: leave default (our `package.json` already runs
     `prisma generate && prisma db push && next build`)
   - **Production Branch**: leave as `main` (the default).
4. Expand **Environment Variables** and paste these. Copy everything in
   the left column as the key, everything in the right as the value:

   | Key | Value |
   |---|---|
   | `SPOTIFY_CLIENT_ID` | `323de6c6b63d458da2c73dfc5b5ee18f` |
   | `SPOTIFY_REDIRECT_URI` | `https://<will-fill-after-deploy>/api/auth/callback` |
   | `APP_BASE_URL` | `https://<will-fill-after-deploy>` |
   | `SESSION_SECRET` | `T7T9YFabQiqjE8gDK0DC74ZUmdFg-IKKKMc-FInmVHA` |
   | `DATABASE_URL` | *(Supabase session pooler string from step 1, port 5432, no query params)* |
   | `CRON_SECRET` | `1Xabh5Se7O5tFirfC6joj56u4OjYQY0GFD5wEOP9XFk` |
   | `VAPID_PUBLIC_KEY` | `BNHedM6mhEotKGY60tb_4qJZ5sbd_8NE0HKe0epaTsSwy1qgDUJDujr58TjmEpWJg1ZxlVur3LckvP9VniYJhlA` |
   | `VAPID_PRIVATE_KEY` | `cTu0SBHSkU1pS1eSIokMQzkhcrZGkGpn4SplDi_4FTE` |
   | `VAPID_SUBJECT` | `mailto:your-email@example.com` |
   | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `BNHedM6mhEotKGY60tb_4qJZ5sbd_8NE0HKe0epaTsSwy1qgDUJDujr58TjmEpWJg1ZxlVur3LckvP9VniYJhlA` |

   > Leave `SPOTIFY_REDIRECT_URI` and `APP_BASE_URL` with the placeholder
   > for now — you'll update them in step 4 once Vercel assigns a URL.

5. Click **Deploy**. Wait ~90 seconds. The build runs `prisma db push`
   against Supabase so your tables get created automatically on the
   first deploy.

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
→ The Supabase connection string is wrong. Most common causes:
1. You forgot to replace `[YOUR-PASSWORD]` with your actual password.
2. Your password contains URL-unsafe characters (`@`, `:`, `/`, `#`,
   `?`). URL-encode them or set a password that's only alphanumerics.
3. Supabase project was paused / deleted.

**Build hangs indefinitely on `prisma db push`**
→ You used the Transaction pooler (port 6543). Prisma DDL doesn't work
through PgBouncer transaction mode — it looks like a hang because the
prepared statements never get a reply. Switch `DATABASE_URL` to the
Session pooler (port 5432) with no query params, redeploy.

**Build fails with `prisma db push` saying drift detected**
→ Someone (you? a previous deploy?) modified the DB schema out-of-band.
Safe fix: in Supabase → SQL Editor, run `DROP SCHEMA public CASCADE;
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
- **DB** — Supabase (Postgres, free tier)
- **Host + cron** — Vercel (`vercel.json` defines `*/10 * * * *`)
- **Auth** — Spotify Developer app (`Claude Code Testing`)
- **Push** — VAPID keys in Vercel env + service worker in
  `public/sw.js`
