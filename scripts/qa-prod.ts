// Headless smoke test against the deployed app. Use this when the
// agent doesn't have a browser MCP — i.e. cloud / mobile sessions
// running on a fresh GitHub clone. It checks that core routes return
// the expected HTTP status (catches build-time crashes, lazy-migration
// failures, and unauth-path regressions) without needing auth.
//
//   npm run qa:prod                       # against playlistwatcher.vercel.app
//   QA_BASE_URL=https://preview-... npm run qa:prod   # against a preview deploy
//
// Exits non-zero on failure so it can gate a merge in CI or in the
// agent loop.

const BASE = process.env.QA_BASE_URL ?? "https://playlistwatcher.vercel.app";

interface Check {
  path: string;
  // Single status, or list of acceptable codes.
  expectStatus: number | number[];
  // Optional substring match on body — only fetched when present.
  expectBodyIncludes?: string;
  description: string;
}

const checks: Check[] = [
  // Pages render (no 500 = lazy migration ran + Prisma schema matches DB).
  {
    path: "/",
    expectStatus: 200,
    description: "Dashboard renders for unauth (sign-in shell)",
  },
  {
    path: "/feed",
    expectStatus: 200,
    expectBodyIncludes: "Sign in to view the feed",
    description: "Feed renders the unauth shell",
  },
  {
    path: "/settings",
    expectStatus: 200,
    expectBodyIncludes: "Sign in required",
    description: "Settings renders the unauth shell",
  },

  // API endpoints behave correctly for unauth.
  {
    path: "/api/push/vapid",
    expectStatus: 200,
    description: "VAPID public key endpoint",
  },
  {
    path: "/api/sync-status",
    expectStatus: 401,
    description: "sync-status returns 401 unauth (not 500 — migration is fine)",
  },
  {
    path: "/api/dashboard",
    expectStatus: 401,
    description: "dashboard API returns 401 unauth (not 500 — Prisma queries work)",
  },
  {
    path: "/api/refresh",
    // Method is POST-only, GET should be 405 Method Not Allowed.
    expectStatus: [401, 405],
    description: "refresh API rejects unauth without crashing",
  },
];

async function runCheck(c: Check): Promise<{ ok: boolean; detail: string }> {
  let res: Response;
  try {
    res = await fetch(BASE + c.path, {
      redirect: "manual",
      headers: { "user-agent": "watcher-qa/1.0" },
    });
  } catch (e) {
    return {
      ok: false,
      detail: `fetch error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const expected = Array.isArray(c.expectStatus)
    ? c.expectStatus
    : [c.expectStatus];
  const okStatus = expected.includes(res.status);
  if (!okStatus) {
    return {
      ok: false,
      detail: `status ${res.status} (expected ${expected.join("|")})`,
    };
  }
  if (c.expectBodyIncludes) {
    const body = await res.text();
    if (!body.includes(c.expectBodyIncludes)) {
      const excerpt = body.slice(0, 160).replace(/\s+/g, " ").trim();
      return {
        ok: false,
        detail: `body missing "${c.expectBodyIncludes}". excerpt: ${excerpt}`,
      };
    }
  }
  return { ok: true, detail: `${res.status}` };
}

async function main() {
  console.log(`[qa-prod] ${BASE}`);
  let failed = 0;
  for (const c of checks) {
    const { ok, detail } = await runCheck(c);
    const symbol = ok ? "✓" : "✗";
    console.log(`  ${symbol} ${c.path.padEnd(20)} ${detail}  — ${c.description}`);
    if (!ok) failed++;
  }
  if (failed > 0) {
    console.log(`\nFAILED: ${failed} of ${checks.length} checks`);
    process.exit(1);
  }
  console.log(`\n${checks.length}/${checks.length} checks passed`);
}

main();
