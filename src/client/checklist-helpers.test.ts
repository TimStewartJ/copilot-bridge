import { describe, expect, it } from "vitest";
import { dashboardChecklistCountClass, resolveFeedActionTaskId } from "./components/Dashboard";
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

describe("dashboardChecklistCountClass", () => {
  it("uses muted styling when there are no urgent checklist deadlines", () => {
    expect(dashboardChecklistCountClass("none")).toContain("text-text-faint");
  });

  it("uses warning styling for due-today checklist deadlines", () => {
    expect(dashboardChecklistCountClass("due-today")).toContain("text-warning");
  });

  it("uses error styling for overdue checklist deadlines", () => {
    expect(dashboardChecklistCountClass("overdue")).toContain("text-error");
  });
});

describe("resolveFeedActionTaskId", () => {
  it("uses the card task when action taskId is omitted", () => {
    expect(resolveFeedActionTaskId({
      taskId: "task-card",
      action: { prompt: "Continue this" },
    })).toBe("task-card");
  });

  it("supports explicit action task override and standalone null", () => {
    expect(resolveFeedActionTaskId({
      taskId: "task-card",
      action: { prompt: "Continue this", taskId: "task-action" },
    })).toBe("task-action");
    expect(resolveFeedActionTaskId({
      taskId: "task-card",
      action: { prompt: "Continue this", taskId: null },
    })).toBeNull();
  });
});
