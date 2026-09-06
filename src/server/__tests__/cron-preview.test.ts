import { describe, expect, it } from "vitest";
import { createCronPreviewIterator, matchesCron } from "../cron-next-run.js";

function collect(expression: string, timezone: string, start: string, end: string, limit = 512) {
  let probes = 0;
  const cursor = createCronPreviewIterator(expression, timezone, Date.parse(start), Date.parse(end), () => {
    if (probes === limit) return false;
    probes++;
    return true;
  });
  const slots: string[] = [];
  while (true) {
    const next = cursor.next();
    if (next.done) return { slots, complete: next.complete, probes };
    slots.push(next.at);
  }
}

describe("bounded cron preview cursor", () => {
  it("jumps between candidate minutes and includes the start but excludes the end", () => {
    const result = collect("0 * * * *", "UTC", "2026-09-05T12:00:00Z", "2026-09-06T12:00:00Z");
    expect(result.complete).toBe(true);
    expect(result.slots).toHaveLength(24);
    expect(result.slots[0]).toBe("2026-09-05T12:00:00.000Z");
    expect(result.slots.at(-1)).toBe("2026-09-06T11:00:00.000Z");
    expect(result.probes).toBeLessThanOrEqual(25);
  });

  it.each([
    ["30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-01T09:00:00Z"],
    ["15,45 * * * *", "Australia/Lord_Howe", "2026-10-03T14:00:00Z", "2026-10-03T17:00:00Z"],
    ["15,45 * * * *", "Australia/Lord_Howe", "2026-04-04T14:00:00Z", "2026-04-04T17:00:00Z"],
    ["45 2 * * *", "Australia/Lord_Howe", "2026-10-03T15:29:00Z", "2026-10-03T16:00:00Z"],
    ["0,30 * * * *", "Asia/Kathmandu", "2026-09-05T11:00:00Z", "2026-09-05T14:00:00Z"],
    ["0 */2 * * sat", "Europe/London", "2026-09-05T11:00:00Z", "2026-09-05T15:00:00Z"],
  ])("preserves real-minute matching for %s in %s", (expression, timezone, start, end) => {
    const expected: string[] = [];
    for (let at = Date.parse(start); at < Date.parse(end); at += 60_000) {
      if (matchesCron(expression, new Date(at), timezone)) expected.push(new Date(at).toISOString());
    }
    const actual = collect(expression, timezone, start, end);
    expect(actual.complete).toBe(true);
    expect(actual.slots).toEqual(expected);
    expect(new Set(actual.slots).size).toBe(actual.slots.length);
  });

  it("counts both repeated DST-fold instants rather than silently declaring the first complete", () => {
    expect(collect("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-01T09:00:00Z").slots)
      .toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  });

  it("stops internal timezone probes even for dense or non-matching seven-day schedules", () => {
    for (const expression of ["* * * * *", "0 0 30 feb *"]) {
      const result = collect(expression, "America/Los_Angeles", "2026-09-05T12:00:00Z", "2026-09-12T12:00:00Z", 32);
      expect(result.complete).toBe(false);
      expect(result.probes).toBe(32);
    }
    expect(collect("* * * * *", "UTC", "2026-09-05T12:00:00Z", "2026-09-12T12:00:00Z", 0))
      .toEqual({ slots: [], complete: false, probes: 0 });
  });
});
