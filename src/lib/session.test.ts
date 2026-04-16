import { describe, it, expect } from "vitest";

// Test session signing without needing the Next.js cookies() context.
// We test the signing/verification logic directly using the internal
// HMAC primitives rather than calling createSessionCookie / readSessionUserId
// which depend on next/headers.

import { createHmac, timingSafeEqual } from "node:crypto";

const TEST_SECRET = "test-secret-at-least-16-chars";

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function verifySignedCookie(
  raw: string,
  secret: string,
): string | null {
  const idx = raw.lastIndexOf(".");
  if (idx < 0) return null;
  const userId = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = sign(userId, secret);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return userId;
}

describe("session signing", () => {
  it("signs and verifies a user id", () => {
    const userId = "clxyz123abc";
    const sig = sign(userId, TEST_SECRET);
    const cookie = `${userId}.${sig}`;
    expect(verifySignedCookie(cookie, TEST_SECRET)).toBe(userId);
  });

  it("rejects tampered user id", () => {
    const sig = sign("realuser", TEST_SECRET);
    const tampered = `attackeruser.${sig}`;
    expect(verifySignedCookie(tampered, TEST_SECRET)).toBeNull();
  });

  it("rejects tampered signature", () => {
    const cookie = "realuser.badSignature";
    expect(verifySignedCookie(cookie, TEST_SECRET)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(verifySignedCookie("", TEST_SECRET)).toBeNull();
  });

  it("rejects string without separator", () => {
    expect(verifySignedCookie("nodot", TEST_SECRET)).toBeNull();
  });

  it("rejects with wrong secret", () => {
    const userId = "user1";
    const sig = sign(userId, TEST_SECRET);
    const cookie = `${userId}.${sig}`;
    expect(verifySignedCookie(cookie, "wrong-secret-16chars")).toBeNull();
  });

  it("handles user id containing dots", () => {
    // cuid IDs don't have dots, but the code uses lastIndexOf(".")
    // so it should handle this edge case.
    const userId = "user.with.dots";
    const sig = sign(userId, TEST_SECRET);
    const cookie = `${userId}.${sig}`;
    expect(verifySignedCookie(cookie, TEST_SECRET)).toBe(userId);
  });
});
