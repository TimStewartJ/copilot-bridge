import { describe, expect, it } from "vitest";
import { draggedTimes, formatFree, freeMinutes, layoutLanes, snapMinutes } from "./calendar-model";

describe("layoutLanes", () => {
  it("places touching blocks, a minimum-height moment and its overlap chain in one day", () => {
    const placed = layoutLanes([
      { id: "walk", start: 480, end: 510 },
      { id: "breakfast", start: 510, end: 540 },
      { id: "reminder", start: 540, end: 540 },
      { id: "review", start: 550, end: 600 },
      { id: "pairing", start: 575, end: 620 },
    ], 20);

    expect(placed.map(({ id, lane, lanes }) => [id, lane, lanes])).toEqual([
      ["walk", 0, 1], ["breakfast", 0, 1], ["reminder", 0, 2], ["review", 1, 2], ["pairing", 0, 2],
    ]);
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
