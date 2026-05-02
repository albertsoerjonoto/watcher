// Headless production QA — the cloud/mobile-friendly counterpart to the
// desktop Chrome MCP step in CLAUDE.md.
//
// Drives a real Chromium against a target deploy URL, asserts the dashboard
// and feed render correctly, and checks console + network are clean. Exits
// 0 on pass, 1 on fail.
//
//   npm run qa:prod
//   npm run qa:prod -- https://watcher-git-some-branch.vercel.app
//
// Auth: set WATCHER_SESSION_COOKIE to the value of the `spw_session` cookie
// from a logged-in browser (DevTools → Application → Cookies). Without it,
// the script runs in smoke-mode (verifies the sign-in page renders without
// errors) — useful for sanity but won't catch UI regressions on the
// authenticated views.
//
// Setup: `npx playwright install chromium` once per environment.

import { chromium, type ConsoleMessage, type Request } from "playwright";

const ARG_URL = process.argv[2];
const PROD_URL = (
  ARG_URL ||
  process.env.WATCHER_PROD_URL ||
  "https://playlistwatcher.vercel.app"
).replace(/\/$/, "");

const SESSION_COOKIE = process.env.WATCHER_SESSION_COOKIE?.trim();

// Browser/extension noise that surfaces as page-level exceptions. These are
// not from our app code and are the same messages Chrome MCP picked up on
// the desktop run; they don't indicate a regression.
const IGNORED_CONSOLE_PATTERNS: RegExp[] = [
  /listener indicated an asynchronous response.*message channel closed/i,
  /Extension context invalidated/i,
  // Next.js logs this when an RSC prefetch is aborted by a real
  // navigation (e.g. our script navigating /  → /feed cancels the
  // hover-prefetch for /feed). The accompanying "Falling back to
  // browser navigation" means the user experience is unaffected.
  /Failed to fetch RSC payload.*Falling back to browser navigation/i,
];

const TIME_RE = /\b\d{1,2}\.\d{2}\b/;
const DATE_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+\w{3}$/;

interface Failure {
  step: string;
  detail: string;
}

const failures: Failure[] = [];
const fail = (step: string, detail: string) => failures.push({ step, detail });

async function main() {
  const cookieDomain = new URL(PROD_URL).hostname;
  const authed = !!SESSION_COOKIE;

  console.log(`→ qa-prod: ${PROD_URL} (auth=${authed ? "yes" : "smoke-only"})`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  if (authed) {
    await context.addCookies([
      {
        name: "spw_session",
        value: SESSION_COOKIE!,
        domain: cookieDomain,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
  }

  const page = await context.newPage();

  const consoleErrors: { text: string; type: string }[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const text = msg.text();
    if (IGNORED_CONSOLE_PATTERNS.some((p) => p.test(text))) return;
    // In smoke mode the layout's AutoRefresh widget fires /api/sync-status
    // and gets a 401, which surfaces as "Failed to load resource: ... 401".
    // That's expected for an unauthenticated visit, not a regression.
    if (!authed && /Failed to load resource.*\b401\b/.test(text)) return;
    consoleErrors.push({ text, type: msg.type() });
  });
  page.on("pageerror", (err) => {
    const text = err.message;
    if (IGNORED_CONSOLE_PATTERNS.some((p) => p.test(text))) return;
    consoleErrors.push({ text, type: "pageerror" });
  });

  const apiCalls: { url: string; status: number; method: string }[] = [];
  page.on("requestfinished", async (req: Request) => {
    const url = req.url();
    if (!url.includes("/api/")) return;
    const res = await req.response();
    if (!res) return;
    apiCalls.push({ url, method: req.method(), status: res.status() });
  });

  try {
    await qaDashboard(page, authed);
    await qaFeed(page, authed);
  } catch (err) {
    fail("uncaught", err instanceof Error ? err.stack || err.message : String(err));
  }

  await browser.close();

  // Summarize console/network across both pages.
  // In smoke mode, 401s on /api/* are expected (the layout's AutoRefresh
  // hits /api/sync-status on every page); only flag 5xx. In auth mode,
  // all /api/* should be 2xx.
  const failingThreshold = authed ? 400 : 500;
  const apiFailures = apiCalls.filter((c) => c.status >= failingThreshold);
  if (apiFailures.length > 0) {
    fail(
      "network",
      `unexpected /api/* responses:\n  ${apiFailures
        .map((c) => `${c.status} ${c.method} ${c.url}`)
        .join("\n  ")}`,
    );
  }
  if (consoleErrors.length > 0) {
    fail(
      "console",
      `app-source errors:\n  ${consoleErrors
        .map((e) => `[${e.type}] ${e.text}`)
        .join("\n  ")}`,
    );
  }

  console.log(`\n--- summary ---`);
  console.log(`API calls: ${apiCalls.length} (${apiFailures.length} non-2xx)`);
  for (const c of apiCalls) {
    console.log(`  ${c.status} ${c.method} ${new URL(c.url).pathname}`);
  }
  console.log(`Console errors: ${consoleErrors.length} (after ignore-list)`);

  if (failures.length === 0) {
    console.log(`\n✓ PASS — ${authed ? "full QA" : "smoke"} on ${PROD_URL}`);
    process.exit(0);
  }
  console.log(`\n✗ FAIL (${failures.length}):`);
  for (const f of failures) {
    console.log(`  [${f.step}] ${f.detail}`);
  }
  process.exit(1);
}

async function qaDashboard(
  page: import("playwright").Page,
  authed: boolean,
): Promise<void> {
  await page.goto(`${PROD_URL}/`, { waitUntil: "domcontentloaded" });

  if (!authed) {
    // Smoke-mode: confirm the sign-in CTA renders.
    const hasSignIn = await page
      .locator('a[href="/api/auth/login"]')
      .first()
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasSignIn) fail("dashboard.smoke", "Sign in link not found");
    return;
  }

  // Wait for at least one tabular-nums time on a recent-tracks row to
  // populate. SWR fallback data renders inline so this is usually instant
  // but allow a couple of seconds for hydration.
  const firstTime = page.locator("time.tabular-nums").first();
  const visible = await firstTime
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    fail("dashboard.render", "no time.tabular-nums element appeared");
    return;
  }

  // Each dashboard recent-track <time> has the date as text + a <span class="ml-2"> child with the time.
  const samples = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLTimeElement>("time.tabular-nums"),
    );
    return els.slice(0, 5).map((el) => {
      const span = el.querySelector(":scope > span.ml-2");
      const fontVariant = getComputedStyle(el).fontVariantNumeric;
      // The element's first child node is the date text; we also keep the
      // full text for shape checks.
      const childTextNodes = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent || "").trim())
        .filter(Boolean);
      return {
        full: el.textContent?.trim() || "",
        datePart: childTextNodes[0] || "",
        timeChild: span?.textContent?.trim() || null,
        fontVariant,
      };
    });
  });

  if (samples.length === 0) {
    fail("dashboard.format", "no time.tabular-nums samples found");
    return;
  }

  let ok = 0;
  for (const s of samples) {
    const dateOk = DATE_RE.test(s.datePart);
    const timeOk = !!s.timeChild && TIME_RE.test(s.timeChild);
    const tabular = s.fontVariant.includes("tabular-nums");
    if (dateOk && timeOk && tabular) ok++;
  }
  if (ok === 0) {
    fail(
      "dashboard.format",
      `no row matched "<date><span.ml-2>HH.MM</span>" with tabular-nums; samples=${JSON.stringify(samples)}`,
    );
  } else {
    console.log(
      `  dashboard: ${ok}/${samples.length} sample rows match date+gap+time format`,
    );
    console.log(`  e.g. "${samples[0].datePart}  ${samples[0].timeChild}"`);
  }
}

async function qaFeed(
  page: import("playwright").Page,
  authed: boolean,
): Promise<void> {
  await page.goto(`${PROD_URL}/feed`, { waitUntil: "domcontentloaded" });

  if (!authed) {
    // Feed redirects unauth'd users to the sign-in page. Just confirm we
    // didn't hit a 5xx.
    return;
  }

  const firstTime = page.locator("time.tabular-nums").first();
  const visible = await firstTime
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    fail("feed.render", "no time.tabular-nums element appeared");
    return;
  }

  const data = await page.evaluate(() => {
    const headers = Array.from(
      document.querySelectorAll<HTMLHeadingElement>("h2"),
    )
      .map((h) => (h.textContent || "").trim())
      .filter(Boolean);
    const times = Array.from(
      document.querySelectorAll<HTMLTimeElement>("time.tabular-nums"),
    )
      .map((t) => (t.textContent || "").trim())
      .filter(Boolean);
    return { headers, times };
  });

  const dateHeaders = data.headers.filter((h) => DATE_RE.test(h));
  if (dateHeaders.length === 0) {
    fail(
      "feed.headers",
      `no h2 day-headers matched date pattern; got: ${JSON.stringify(data.headers.slice(0, 5))}`,
    );
  }
  const timeOnly = data.times.filter((t) => /^\d{1,2}\.\d{2}$/.test(t));
  if (timeOnly.length === 0) {
    fail(
      "feed.times",
      `no per-track time-only entries found; got: ${JSON.stringify(data.times.slice(0, 5))}`,
    );
  }
  if (dateHeaders.length > 0 && timeOnly.length > 0) {
    console.log(
      `  feed: ${dateHeaders.length} day headers, ${timeOnly.length} time entries`,
    );
    console.log(`  e.g. header="${dateHeaders[0]}", time="${timeOnly[0]}"`);
  }
}

main().catch((err) => {
  console.error("qa-prod crashed:", err);
  process.exit(2);
});
