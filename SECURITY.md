# Security

## Known historical secret leak

Between the initial Vercel deploy commit and the cleanup in this PR,
`DEPLOY.md` contained the live production values of:

- `SESSION_SECRET` — used to HMAC-sign session cookies. Anyone who
  has it can forge a valid cookie for any user_id.
- `CRON_SECRET` — used to gate `/api/cron/poll`. Anyone who has it
  can trigger a poll arbitrarily, which doesn't expose data but does
  consume Spotify rate-limit budget.
- `VAPID_PRIVATE_KEY` — used to sign Web Push messages. Anyone who
  has it can send pushes to any subscribed device for this app.

These values are in this repo's git history. Removing them from the
current file does NOT un-leak them. The repo is public, so assume
they are compromised.

### What to rotate

Rotate all three immediately, in this order:

1. **`SESSION_SECRET`** — generate `openssl rand -base64 32`, set in
   Vercel env, redeploy. All existing sessions will invalidate; users
   sign in once.
2. **`CRON_SECRET`** — generate `openssl rand -base64 32`, set in
   Vercel env. Update the Vercel cron job's auth header (Vercel UI:
   Project → Settings → Cron Jobs → edit the schedule's auth).
3. **`VAPID_PRIVATE_KEY` + `VAPID_PUBLIC_KEY`** — `npx web-push
   generate-vapid-keys`, set both in Vercel env (and
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY` to the public half). Existing push
   subscriptions will become invalid; the next time a device opens
   the app it will re-subscribe automatically (per Service Worker
   logic in `public/sw.js`).

### What does NOT need rotation

- `SPOTIFY_CLIENT_ID` is intentionally public (PKCE OAuth flow has
  no client secret).
- `DATABASE_URL` was never in the repo (slot was always `(Neon
  connection string from step 1)`). Verify, but it should be safe.

## Reporting

For new vulnerabilities, open a private issue / contact the repo
owner directly. Don't post details in a public PR or comment.
