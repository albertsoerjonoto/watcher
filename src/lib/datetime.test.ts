import { describe, it, expect } from "vitest";
import {
  formatDateJakarta,
  formatDateTimeJakarta,
  formatTimeJakarta,
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

describe("formatTimeJakarta", () => {
  it("formats time with a dot separator", () => {
    // 2026-04-30T07:33:00Z = 2026-04-30 14:33 Jakarta
    expect(formatTimeJakarta("2026-04-30T07:33:00Z")).toBe("14.33");
  });

  it("zero-pads hours and minutes", () => {
    // 2026-04-30T01:05:00Z = 2026-04-30 08:05 Jakarta
    expect(formatTimeJakarta("2026-04-30T01:05:00Z")).toBe("08.05");
  });

  it("returns em dash for null", () => {
    expect(formatTimeJakarta(null)).toBe("—");
  });

  it("returns em dash for invalid date string", () => {
    expect(formatTimeJakarta("not-a-date")).toBe("—");
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
