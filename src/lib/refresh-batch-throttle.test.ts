import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Guardrail: every endpoint that does Spotify polling work — i.e.
// /api/refresh and /api/cron/poll — MUST call the batch throttle.
// The May 2026 ~28-minute cooldown happened because /api/refresh had
// no batch-level throttle: a fresh JS context (cleared SW / localStorage)
// re-mounting the dashboard fired the endpoint repeatedly, each
// invocation passing the per-playlist staleness gate, the aggregate
// blowing past Spotify's actual rolling limit. The hard rule is now:
//
//   - Read getRefreshBatchThrottleSeconds() before any Spotify work
//   - Bail out (skipped: "throttled") if > 0
//   - Otherwise call recordRefreshBatchStarted() before the first
//     spotifyFetch
//
// This file enforces that pattern lexically. If the names ever drift,
// update both this test and the entry-point routes together.

const SRC_ROOT = path.resolve(__dirname, "..");

const REQUIRED_THROTTLE_CALLERS = [
  "app/api/refresh/route.ts",
  "app/api/cron/poll/route.ts",
];

describe("refresh-batch throttle guardrail", () => {
  for (const rel of REQUIRED_THROTTLE_CALLERS) {
    it(`${rel} calls the batch-throttle guards`, () => {
      const file = path.join(SRC_ROOT, rel);
      const content = fs.readFileSync(file, "utf-8");
      // Both functions must be referenced. We don't enforce CALL ORDER
      // lexically (the route code is allowed to early-return on cooldown
      // before the throttle check), but both must appear so a careless
      // refactor that drops one fails CI.
      expect(content, `${rel} must call getRefreshBatchThrottleSeconds`).toMatch(
        /getRefreshBatchThrottleSeconds\s*\(/,
      );
      expect(content, `${rel} must call recordRefreshBatchStarted`).toMatch(
        /recordRefreshBatchStarted\s*\(/,
      );
    });
  }

  it("the rate-limit module exports the batch-throttle helpers", () => {
    const file = path.resolve(__dirname, "rate-limit.ts");
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toMatch(/export\s+async\s+function\s+getRefreshBatchThrottleSeconds/);
    expect(content).toMatch(/export\s+async\s+function\s+recordRefreshBatchStarted/);
    expect(content).toMatch(/export\s+async\s+function\s+assertCanStartRefreshBatch/);
  });
});
