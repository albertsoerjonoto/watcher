import { describe, it, expect } from "vitest";
import {
  formatDateJakarta,
  formatDateTimeJakarta,
  dayKeyJakarta,
} from "./datetime";

describe("formatDateJakarta", () => {
  it("formats a date in Jakarta timezone", () => {
    // 2026-04-16T00:00:00Z = 2026-04-16 07:00 Jakarta
    const result = formatDateJakarta("2026-04-16T00:00:00Z");
    expect(result).toMatch(/Thu/);
    expect(result).toMatch(/16/);
    expect(result).toMatch(/Apr/);
  });

  it("returns em dash for null", () => {
    expect(formatDateJakarta(null)).toBe("\u2014");
  });

  it("returns em dash for undefined", () => {
    expect(formatDateJakarta(undefined)).toBe("\u2014");
  });

  it("returns em dash for invalid date string", () => {
    expect(formatDateJakarta("not-a-date")).toBe("\u2014");
  });

  it("accepts Date objects", () => {
    const result = formatDateJakarta(new Date("2026-01-01T00:00:00Z"));
    expect(result).toMatch(/Jan/);
  });
});

describe("formatDateTimeJakarta", () => {
  it("formats date and time with dots", () => {
    // 2026-04-16T07:30:00Z = 2026-04-16 14:30 Jakarta
    const result = formatDateTimeJakarta("2026-04-16T07:30:00Z");
    expect(result).toMatch(/14\.30/);
  });

  it("returns em dash for null", () => {
    expect(formatDateTimeJakarta(null)).toBe("\u2014");
  });
});

describe("dayKeyJakarta", () => {
  it("returns YYYY-MM-DD in Jakarta timezone", () => {
    // 2026-04-15T20:00:00Z = 2026-04-16 03:00 Jakarta → key is 2026-04-16
    expect(dayKeyJakarta("2026-04-15T20:00:00Z")).toBe("2026-04-16");
  });

  it("respects timezone boundary", () => {
    // 2026-04-15T16:59:00Z = 2026-04-15 23:59 Jakarta → still 2026-04-15
    expect(dayKeyJakarta("2026-04-15T16:59:00Z")).toBe("2026-04-15");
  });
});
