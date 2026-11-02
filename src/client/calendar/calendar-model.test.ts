import { describe, expect, it } from "vitest";
import { draggedTimes, formatFree, freeMinutes, layoutLanes, snapMinutes } from "./calendar-model";

describe("layoutLanes", () => {
  it.each([
    { name: "apart blocks each take the whole column", spans: [["a", 60, 120], ["b", 120, 180]], expected: { a: [0, 1], b: [0, 1] } },
    { name: "overlapping blocks share it", spans: [["a", 60, 180], ["b", 90, 120]], expected: { a: [0, 2], b: [1, 2] } },
    { name: "a chain of overlaps is one cluster, reusing a freed lane", spans: [["a", 0, 60], ["b", 30, 120], ["c", 90, 150]], expected: { a: [0, 2], b: [1, 2], c: [0, 2] } },
    { name: "a moment gets a minimum height before it is placed", spans: [["a", 60, 60], ["b", 70, 80]], expected: { a: [0, 2], b: [1, 2] } },
  ])("$name", ({ spans, expected }) => {
    const placed = layoutLanes(spans.map(([id, start, end]) => ({ id: id as string, start: start as number, end: end as number })), 20);
    expect(Object.fromEntries(placed.map((span) => [span.id, [span.lane, span.lanes]]))).toEqual(expected);
  });
});

describe("freeMinutes", () => {
  it.each([
    { name: "an empty day from its start", busy: [], now: 0, expected: 13 * 60 },
    { name: "only what is left of the day", busy: [], now: 20 * 60, expected: 60 },
    { name: "overlapping events count once", busy: [{ start: 9 * 60, end: 11 * 60 }, { start: 10 * 60, end: 12 * 60 }], now: 0, expected: 10 * 60 },
    { name: "time outside waking hours is not free time", busy: [{ start: 6 * 60, end: 9 * 60 }], now: 0, expected: 12 * 60 },
    { name: "after the day ends", busy: [], now: 22 * 60, expected: 0 },
  ])("$name", ({ busy, now, expected }) => {
    expect(freeMinutes(busy, now)).toBe(expected);
  });

  it.each([[0, "No free time left"], [10, "15 min free"], [100, "1 h 45 min free"], [750, "12 h 30 min free"]])("formats %d minutes", (minutes, text) => {
    expect(formatFree(minutes)).toBe(text);
  });
});

describe("draggedTimes", () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
  it.each([
    { name: "a move keeps the length", change: { mode: "move", dayOffset: 0, minuteDelta: 90 }, expected: [at(2, 10, 30), at(2, 11, 30)] },
    { name: "a move to another day keeps the clock time", change: { mode: "move", dayOffset: 2, minuteDelta: -60 }, expected: [at(4, 8), at(4, 9)] },
    { name: "a resize moves only the end", change: { mode: "resize", dayOffset: 0, minuteDelta: 45 }, expected: [at(2, 9), at(2, 10, 45)] },
    { name: "a resize never goes below one snap", change: { mode: "resize", dayOffset: 0, minuteDelta: -120 }, expected: [at(2, 9), at(2, 9, 15)] },
  ] as const)("$name", ({ change, expected }) => {
    const next = draggedTimes(at(2, 9), at(2, 10), change);
    expect([next.start, next.end]).toEqual(expected);
  });

  it("snaps pointer travel to quarter hours", () => {
    expect([snapMinutes(10, 48), snapMinutes(30, 48), snapMinutes(-50, 48)]).toEqual([15, 45, -60]);
  });
});
