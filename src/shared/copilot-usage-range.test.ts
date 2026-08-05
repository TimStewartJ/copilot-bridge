import { describe, expect, it } from "vitest";
import {
  COPILOT_USAGE_RANGE_KEYS,
  copilotUsageDayKey,
  isCopilotUsageRangeKey,
  normalizeCopilotUsageRangeKey,
  resolveCopilotUsageRange,
} from "./copilot-usage-range.js";

// Local anchors keep month/year boundaries deterministic in any timezone.
const NOW = new Date(2026, 4, 15, 12, 30, 0);

function localStart(year: number, monthIndex: number, day: number): string {
  return new Date(year, monthIndex, day, 0, 0, 0, 0).toISOString();
}

describe("copilot usage range keys", () => {
  it("exposes the five supported windows", () => {
    expect([...COPILOT_USAGE_RANGE_KEYS]).toEqual(["7d", "28d", "mtd", "ytd", "all"]);
  });

  it("recognizes and normalizes range keys", () => {
    expect(isCopilotUsageRangeKey("28d")).toBe(true);
    expect(isCopilotUsageRangeKey("30d")).toBe(false);
    expect(normalizeCopilotUsageRangeKey("ytd")).toBe("ytd");
    expect(normalizeCopilotUsageRangeKey(undefined)).toBe("all");
    expect(normalizeCopilotUsageRangeKey("nope")).toBe("all");
  });
});

describe("resolveCopilotUsageRange", () => {
  it("anchors rolling windows to the start of the local day", () => {
    expect(resolveCopilotUsageRange("7d", NOW.getTime())).toEqual({
      key: "7d",
      label: "7 days",
      startAt: localStart(2026, 4, 9),
      startDate: "2026-05-09",
    });
    expect(resolveCopilotUsageRange("28d", NOW.getTime()).startDate).toBe("2026-04-18");
  });

  it("anchors calendar windows to the local month and year", () => {
    expect(resolveCopilotUsageRange("mtd", NOW.getTime()).startDate).toBe("2026-05-01");
    expect(resolveCopilotUsageRange("ytd", NOW.getTime()).startDate).toBe("2026-01-01");
  });

  it("leaves the all-time window unbounded", () => {
    expect(resolveCopilotUsageRange("all", NOW.getTime())).toEqual({
      key: "all",
      label: "All time",
      startAt: null,
      startDate: null,
    });
  });

  it("crosses month and year boundaries when counting back", () => {
    const marchFirst = new Date(2026, 2, 1, 8, 0, 0).getTime();
    expect(resolveCopilotUsageRange("7d", marchFirst).startDate).toBe("2026-02-23");

    const januarySecond = new Date(2026, 0, 2, 8, 0, 0).getTime();
    expect(resolveCopilotUsageRange("28d", januarySecond).startDate).toBe("2025-12-06");
    expect(resolveCopilotUsageRange("ytd", januarySecond).startDate).toBe("2026-01-01");
  });
});

describe("copilotUsageDayKey", () => {
  it("returns a zero-padded local day key", () => {
    expect(copilotUsageDayKey(new Date(2026, 0, 5, 23, 59, 59))).toBe("2026-01-05");
    expect(copilotUsageDayKey(new Date(2026, 8, 9, 0, 0, 0).toISOString())).toBe("2026-09-09");
  });

  it("returns null for unparseable values", () => {
    expect(copilotUsageDayKey("not-a-date")).toBeNull();
  });
});
