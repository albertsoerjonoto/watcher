import { describe, it, expect } from "vitest";
import { shouldNotifyForSection } from "./poll";

const flags = (
  main: boolean,
  newer: boolean,
  other: boolean,
): { notifyMain: boolean; notifyNew: boolean; notifyOther: boolean } => ({
  notifyMain: main,
  notifyNew: newer,
  notifyOther: other,
});

describe("shouldNotifyForSection", () => {
  it("returns the matching flag for each known section", () => {
    expect(shouldNotifyForSection(flags(true, false, false), "main")).toBe(true);
    expect(shouldNotifyForSection(flags(false, true, false), "new")).toBe(true);
    expect(shouldNotifyForSection(flags(false, false, true), "other")).toBe(true);
  });

  it("returns false when the matching flag is off", () => {
    expect(shouldNotifyForSection(flags(false, true, true), "main")).toBe(false);
    expect(shouldNotifyForSection(flags(true, false, true), "new")).toBe(false);
    expect(shouldNotifyForSection(flags(true, true, false), "other")).toBe(false);
  });

  it("returns true for every section when all flags are on (default user state)", () => {
    const allOn = flags(true, true, true);
    expect(shouldNotifyForSection(allOn, "main")).toBe(true);
    expect(shouldNotifyForSection(allOn, "new")).toBe(true);
    expect(shouldNotifyForSection(allOn, "other")).toBe(true);
  });

  it("returns false for unknown sections regardless of flag state", () => {
    expect(shouldNotifyForSection(flags(true, true, true), "archive")).toBe(false);
    expect(shouldNotifyForSection(flags(true, true, true), "")).toBe(false);
  });
});
