import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "./api";
import TaskMomentumFields, {
  getFollowUpState,
  getPanelFieldTone,
  getVisibleMomentumFieldKeys,
  isExpandablePanelValue,
  toDateTimeInputValue,
  toDateTimeStorageValue,
} from "./components/TaskMomentumFields";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Momentum task",
    kind: "task",
    muted: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    tags: [],
    ...overrides,
  };
}

describe("getFollowUpState", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");

  it("treats future follow-ups as upcoming even later the same day", () => {
    expect(getFollowUpState("2026-05-01T13:00:00.000Z", now)).toBe("upcoming");
  });

  it("treats past-due follow-ups from today as due", () => {
    expect(getFollowUpState("2026-05-01T11:00:00.000Z", now)).toBe("due");
  });

  it("treats prior-day follow-ups as overdue", () => {
    expect(getFollowUpState("2026-04-30T23:00:00.000Z", now)).toBe("overdue");
  });
});

describe("follow-up datetime conversions", () => {
  it("round-trips datetime-local values through ISO storage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T08:00:00.000Z"));

    try {
      const stored = toDateTimeStorageValue("2026-05-02T09:30");
      expect(stored).toBe(new Date("2026-05-02T09:30").toISOString());
      expect(toDateTimeInputValue(stored)).toBe("2026-05-02T09:30");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getPanelFieldTone", () => {
  const now = new Date("2026-05-01T12:00");

  it("uses warning tone for same-day passed follow-ups", () => {
    expect(getPanelFieldTone("nextTouchAt", "2026-05-01T11:00", now)).toBe("warning");
  });

  it("uses danger tone for prior-day follow-ups", () => {
    expect(getPanelFieldTone("nextTouchAt", "2026-04-30T23:00", now)).toBe("danger");
  });

  it("keeps upcoming follow-ups neutral", () => {
    expect(getPanelFieldTone("nextTouchAt", "2026-05-01T13:00", now)).toBeNull();
  });

  it("keeps non-follow-up fields neutral", () => {
    expect(getPanelFieldTone("nextAction", "Ship preview polish", now)).toBeNull();
  });
});

describe("getVisibleMomentumFieldKeys", () => {
  it("keeps doneWhen for normal tasks", () => {
    expect(getVisibleMomentumFieldKeys("task")).toContain("doneWhen");
  });

  it("hides doneWhen for ongoing items", () => {
    expect(getVisibleMomentumFieldKeys("ongoing")).toEqual(["nextAction", "waitingOn", "nextTouchAt"]);
  });
});

describe("isExpandablePanelValue", () => {
  it("keeps short values static", () => {
    expect(isExpandablePanelValue("Ship the preview")).toBe(false);
  });

  it("expands long values and multiline values", () => {
    expect(isExpandablePanelValue("x".repeat(97))).toBe(true);
    expect(isExpandablePanelValue("Line one\nLine two")).toBe(true);
  });
});

describe("TaskMomentumFields panel rendering", () => {
  it("renders long values as implicitly expandable read surfaces with separate edit and clear controls", () => {
    const html = renderToStaticMarkup(createElement(TaskMomentumFields, {
      task: createTask({
        nextAction: "Next scheduled quick sweep. 18:15 PT quick-sweep final state after cleanup: dashboard has 20 active tasks, 0 open checklist items, and the remaining work is ready for review.",
      }),
    }));

    expect(html).toContain('aria-label="Expand Next action"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Edit Next action"');
    expect(html).toContain('aria-label="Clear Next action"');
    expect(html).toContain("line-clamp-3");
    expect(html).toContain("md:line-clamp-2");
    expect(html).not.toContain("More");
  });

  it("renders short values without an expand affordance", () => {
    const html = renderToStaticMarkup(createElement(TaskMomentumFields, {
      task: createTask({ nextAction: "Ship the preview" }),
    }));

    expect(html).not.toContain('aria-label="Expand Next action"');
    expect(html).not.toContain("More");
    expect(html).toContain('aria-label="Edit Next action"');
  });
});
