import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Guardrail: no raw fetch() to any Spotify host outside of rate-limit.ts.
//
// The April 2026 lockout happened because a debug route fired 20+ raw
// fetch() calls to api.spotify.com with zero rate-limit gating. This
// test ensures every Spotify call goes through the spotifyFetch()
// chokepoint in src/lib/rate-limit.ts.

const SRC_ROOT = path.resolve(__dirname, "..");

// Spotify hosts that share the rate-limit bucket.
const SPOTIFY_HOST_PATTERNS = [
  "api.spotify.com",
  "accounts.spotify.com",
  "api-partner.spotify.com",
  "open.spotify.com",
];

// The ONLY file allowed to call raw fetch() to Spotify hosts.
const ALLOWED_FILE = path.resolve(__dirname, "rate-limit.ts");

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".next") {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("rate-limit guardrail", () => {
  it("no raw fetch() to Spotify hosts outside rate-limit.ts", () => {
    const files = collectTsFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      if (file === ALLOWED_FILE) continue;
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments.
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        // Look for fetch( followed by a Spotify host, either as a
        // template literal or string literal. Must NOT be preceded by
        // "spotify" (which would be spotifyFetch).
        for (const host of SPOTIFY_HOST_PATTERNS) {
          // Match: fetch(`...spotify.com...`) or fetch("...spotify.com...")
          // But NOT: spotifyFetch(...)
          const pattern = new RegExp(
            `(?<!\\w)fetch\\s*\\([^)]*${host.replace(/\./g, "\\.")}`,
          );
          if (pattern.test(line)) {
            violations.push(
              `${path.relative(SRC_ROOT, file)}:${i + 1}: raw fetch() to ${host}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("spotifyFetch is the only fetch-to-Spotify in rate-limit.ts", () => {
    const content = fs.readFileSync(ALLOWED_FILE, "utf-8");
    const lines = content.split("\n");
    const fetchCalls: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      // Actual raw fetch() call — require `await fetch(` to distinguish
      // real calls from string mentions like "use the global fetch()".
      if (/await\s+fetch\s*\(/.test(lines[i])) {
        fetchCalls.push(i + 1);
      }
    }

    // There should be exactly 1 raw fetch() call in rate-limit.ts —
    // inside the spotifyFetch function body.
    expect(fetchCalls.length).toBe(1);
  });
});
