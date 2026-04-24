import { describe, expect, it } from "vitest";
import { describeHomeChecklistIndicator, getHomeChecklistIndicator } from "./checklist-helpers";

describe("getHomeChecklistIndicator", () => {
  const today = new Date(2026, 3, 21, 12, 0, 0);

  it("returns none when there are no due-today or overdue open checklist items", () => {
    const indicator = getHomeChecklistIndicator([
      { deadline: "2026-04-22" },
      { deadline: "2026-04-25" },
      { deadline: undefined },
    ], today);

    expect(indicator).toEqual({
      state: "none",
      dueTodayCount: 0,
      overdueCount: 0,
      urgentCount: 0,
    });
  });

  it("returns due-today when open checklist items are due today", () => {
    const indicator = getHomeChecklistIndicator([
      { deadline: "2026-04-21" },
      { deadline: "2026-04-21" },
      { deadline: "2026-04-22" },
    ], today);

    expect(indicator).toEqual({
      state: "due-today",
      dueTodayCount: 2,
      overdueCount: 0,
      urgentCount: 2,
    });
    expect(describeHomeChecklistIndicator(indicator)).toBe("2 checklist items due today");
  });

  it("returns overdue when any open checklist item is overdue", () => {
    const indicator = getHomeChecklistIndicator([
      { deadline: "2026-04-19" },
      { deadline: "2026-04-21" },
      { deadline: "2026-04-20", done: true },
    ], today);

    expect(indicator).toEqual({
      state: "overdue",
      dueTodayCount: 1,
      overdueCount: 1,
      urgentCount: 2,
    });
    expect(describeHomeChecklistIndicator(indicator)).toBe("1 overdue checklist item");
  });
});
