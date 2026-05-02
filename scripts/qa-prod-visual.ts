// Visual QA — complements scripts/qa-prod.ts. Where qa-prod.ts checks
// HTTP-level health (no 500s, lazy migration applied, expected unauth
// status codes), this script drives a real headless Chromium against
// the authenticated dashboard and feed and asserts the rendered DOM
// matches expectations.
//
//   WATCHER_SESSION_COOKIE=<value> npm run qa:prod:visual
//   WATCHER_SESSION_COOKIE=<value> QA_BASE_URL=https://preview-... \
//     npm run qa:prod:visual
//
// Without WATCHER_SESSION_COOKIE the script prints "skipped" and exits 0.
// That keeps the agent loop green when nobody has provisioned a cookie
// yet — qa-prod.ts is the always-on smoke check; this one upgrades to
// authenticated visual coverage when a cookie is available.
//
// One-time setup per environment: `npm run qa:prod:install` to fetch
// the chromium binary.
//
// Cookie source: open https://playlistwatcher.vercel.app in a logged-in
// browser → DevTools → Application → Cookies → copy `spw_session` value.
// Cookies are HMAC-signed with a 30-day TTL, so refresh roughly monthly.

import { chromium, type ConsoleMessage, type Page } from "playwright";

const BASE = (
  process.env.QA_BASE_URL ?? "https://playlistwatcher.vercel.app"
).replace(/\/$/, "");
const SESSION_COOKIE = process.env.WATCHER_SESSION_COOKIE?.trim();

if (!SESSION_COOKIE) {
  console.log(
    "[qa-prod:visual] skipped — WATCHER_SESSION_COOKIE not set.\n" +
      "  This is fine; qa-prod.ts already covered HTTP-level health.\n" +
      "  To enable visual QA, paste the spw_session cookie value into\n" +
      "  WATCHER_SESSION_COOKIE — see scripts/qa-prod-visual.ts header.",
  );
  process.exit(0);
}

// Browser/extension noise that surfaces as page-level errors but isn't
// from app code. Match conservatively — we'd rather flag a real error
// than silently swallow one.
const IGNORED_CONSOLE_PATTERNS: RegExp[] = [
  /listener indicated an asynchronous response.*message channel closed/i,
  /Extension context invalidated/i,
  // Next.js logs this when a hover-prefetch RSC request is aborted by
  // a real navigation (we navigate / → /feed which cancels the prefetch).
  // The "Falling back to browser navigation" tail confirms the user
  // experience is unaffected.
  /Failed to fetch RSC payload.*Falling back to browser navigation/i,
];

const TIME_RE = /^\d{1,2}\.\d{2}$/;
const DATE_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+\w{3}$/;

interface Failure {
  step: string;
  detail: string;
}

const failures: Failure[] = [];
const fail = (step: string, detail: string) =>
  failures.push({ step, detail });

async function main() {
  console.log(`[qa-prod:visual] ${BASE} (auth=yes)`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    {
      name: "spw_session",
      value: SESSION_COOKIE!,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();

  const consoleErrors: { text: string; type: string }[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const text = msg.text();
    if (IGNORED_CONSOLE_PATTERNS.some((p) => p.test(text))) return;
    consoleErrors.push({ text, type: msg.type() });
  });
  page.on("pageerror", (err) => {
    const text = err.message;
    if (IGNORED_CONSOLE_PATTERNS.some((p) => p.test(text))) return;
    consoleErrors.push({ text, type: "pageerror" });
  });

  const apiCalls: { url: string; status: number; method: string }[] = [];
  page.on("requestfinished", async (req) => {
    const url = req.url();
    if (!url.includes("/api/")) return;
    const res = await req.response();
    if (!res) return;
    apiCalls.push({ url, method: req.method(), status: res.status() });
  });

  try {
    await qaDashboard(page);
    await qaFeed(page);
  } catch (err) {
    fail("uncaught", err instanceof Error ? err.stack || err.message : String(err));
  }

  await browser.close();

  const apiFailures = apiCalls.filter((c) => c.status >= 400);
  if (apiFailures.length > 0) {
    fail(
      "network",
      `non-2xx /api/* responses:\n  ${apiFailures
        .map((c) => `${c.status} ${c.method} ${new URL(c.url).pathname}`)
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
    console.log(`\n✓ PASS — visual QA on ${BASE}`);
    process.exit(0);
  }
  console.log(`\n✗ FAIL (${failures.length}):`);
  for (const f of failures) {
    console.log(`  [${f.step}] ${f.detail}`);
  }
  console.log(
    `\nIf this only fails on \`auth\` checks, the cookie may have expired.\n` +
      `Refresh WATCHER_SESSION_COOKIE from a logged-in browser and re-run.`,
  );
  process.exit(1);
}

async function qaDashboard(page: Page): Promise<void> {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

  // The recent-tracks <time> elements have class `tabular-nums` and
  // contain "<DateText><span class='ml-2'>HH.MM</span>". Wait for the
  // first one to render — SSR-inlined fallbackData should make this
  // near-instant, but allow a few seconds for hydration.
  const firstTime = page.locator("time.tabular-nums").first();
  const visible = await firstTime
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    // Probably an auth failure — landed on the sign-in shell instead
    // of the dashboard.
    const hasSignIn = (await page.locator('a[href="/api/auth/login"]').count()) > 0;
    fail(
      "dashboard.auth",
      hasSignIn
        ? "landed on sign-in page — cookie likely expired or invalid"
        : "no time.tabular-nums element appeared within 15s",
    );
    return;
  }

  const samples = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLTimeElement>("time.tabular-nums"),
    );
    return els.slice(0, 5).map((el) => {
      const span = el.querySelector(":scope > span.ml-2");
      const fontVariant = getComputedStyle(el).fontVariantNumeric;
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
      `  dashboard: ${ok}/${samples.length} rows match date+gap+time format`,
    );
    console.log(`  e.g. "${samples[0].datePart}  ${samples[0].timeChild}"`);
  }
}

async function qaFeed(page: Page): Promise<void> {
  await page.goto(`${BASE}/feed`, { waitUntil: "domcontentloaded" });

  const firstTime = page.locator("time.tabular-nums").first();
  const visible = await firstTime
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    fail("feed.render", "no time.tabular-nums element appeared within 15s");
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
  const timeOnly = data.times.filter((t) => TIME_RE.test(t));
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
  console.error("qa-prod:visual crashed:", err);
  process.exit(2);
});
