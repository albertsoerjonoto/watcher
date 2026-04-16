import { describe, it, expect } from "vitest";
import {
  generateCodeVerifier,
  codeChallengeFromVerifier,
  randomState,
} from "./pkce";

describe("PKCE", () => {
  it("generates a code verifier of expected length", () => {
    const v = generateCodeVerifier();
    // 32 bytes base64url encoded = 43 chars
    expect(v.length).toBeGreaterThanOrEqual(40);
    expect(v.length).toBeLessThanOrEqual(50);
    // Should only contain base64url chars
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates unique verifiers", () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    expect(v1).not.toBe(v2);
  });

  it("generates a valid S256 challenge from verifier", () => {
    const v = generateCodeVerifier();
    const c = codeChallengeFromVerifier(v);
    // SHA-256 base64url = 43 chars
    expect(c.length).toBeGreaterThanOrEqual(40);
    expect(c.length).toBeLessThanOrEqual(50);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("same verifier produces same challenge (deterministic)", () => {
    const v = generateCodeVerifier();
    expect(codeChallengeFromVerifier(v)).toBe(codeChallengeFromVerifier(v));
  });

  it("different verifiers produce different challenges", () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    expect(codeChallengeFromVerifier(v1)).not.toBe(
      codeChallengeFromVerifier(v2),
    );
  });

  it("generates a random state string", () => {
    const s = randomState();
    expect(s.length).toBeGreaterThanOrEqual(20);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates unique state strings", () => {
    expect(randomState()).not.toBe(randomState());
  });
});
