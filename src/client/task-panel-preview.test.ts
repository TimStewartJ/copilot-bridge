import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChecklistItem, Session } from "./api";
import {
  TASK_PANEL_CHECKLIST_PREVIEW_LIMIT,
  TASK_PANEL_SESSION_PREVIEW_LIMIT,
  getTaskPanelChecklistPreview,
  sortTaskPanelSessions,
} from "./task-panel-preview";

const NOW = "2026-04-17T15:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-17T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    modifiedTime: NOW,
    lastVisibleActivityAt: NOW,
    busy: false,
    archived: false,
    ...overrides,
  };
}

function createChecklistItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: "checklist-1",
    taskId: "task-1",
    text: "Checklist item",
    done: false,
    order: 0,
    createdAt: NOW,
    ...overrides,
  };
}

describe("sortTaskPanelSessions", () => {
  it("keeps the active session first and prioritizes stalled, busy, unread, then recency", () => {
    const sessions = [
      createSession({ sessionId: "recent-idle", lastVisibleActivityAt: "2026-04-17T14:00:00.000Z" }),
      createSession({ sessionId: "stalled", runState: "stalled", busy: true, lastVisibleActivityAt: "2026-04-17T12:00:00.000Z" }),
      createSession({ sessionId: "busy", runState: "busy", busy: true, lastVisibleActivityAt: "2026-04-17T13:00:00.000Z" }),
      createSession({ sessionId: "unread", lastVisibleActivityAt: "2026-04-17T11:00:00.000Z" }),
      createSession({ sessionId: "archived", archived: true, lastVisibleActivityAt: "2026-04-17T16:00:00.000Z" }),
      createSession({ sessionId: "current", lastVisibleActivityAt: "2026-04-17T10:00:00.000Z" }),
    ];

    const preview = sortTaskPanelSessions(
      sessions,
      "current",
      (sessionId) => sessionId === "unread" || sessionId === "archived",
    );

    expect(preview.slice(0, TASK_PANEL_SESSION_PREVIEW_LIMIT).map((session) => session.sessionId)).toEqual([
      "current",
      "stalled",
      "busy",
      "unread",
    ]);
  });
});

describe("getTaskPanelChecklistPreview", () => {
  it("prioritizes overdue, soon, then oldest open checklist items", () => {
    const preview = getTaskPanelChecklistPreview([
      createChecklistItem({ id: "oldest-open", createdAt: "2026-04-10T09:00:00.000Z" }),
      createChecklistItem({ id: "newer-open", createdAt: "2026-04-16T09:00:00.000Z" }),
      createChecklistItem({ id: "soon", deadline: "2026-04-18", createdAt: "2026-04-12T09:00:00.000Z" }),
      createChecklistItem({ id: "overdue", deadline: "2026-04-16", createdAt: "2026-04-13T09:00:00.000Z" }),
      createChecklistItem({ id: "completed", done: true, completedAt: "2026-04-17T09:00:00.000Z" }),
    ]);

    expect(preview.openPreviewItems.map((item) => item.id)).toEqual([
      "overdue",
      "soon",
      "oldest-open",
    ]);
    expect(preview.hiddenOpenCount).toBe(1);
    expect(preview.completedCount).toBe(1);
    expect(preview.overdueCount).toBe(1);
    expect(preview.dueSoonCount).toBe(1);
  });

  it("keeps a highlighted open item visible even when it falls outside the preview limit", () => {
    const preview = getTaskPanelChecklistPreview([
      createChecklistItem({ id: "first-overdue", deadline: "2026-04-16", createdAt: "2026-04-12T09:00:00.000Z" }),
      createChecklistItem({ id: "second-overdue", deadline: "2026-04-16", createdAt: "2026-04-13T09:00:00.000Z" }),
      createChecklistItem({ id: "due-soon", deadline: "2026-04-18", createdAt: "2026-04-14T09:00:00.000Z" }),
      createChecklistItem({ id: "highlighted-oldest", createdAt: "2026-04-10T09:00:00.000Z" }),
    ], {
      highlightId: "highlighted-oldest",
    });

    expect(preview.openPreviewItems).toHaveLength(TASK_PANEL_CHECKLIST_PREVIEW_LIMIT);
    expect(preview.openPreviewItems.map((item) => item.id)).toContain("highlighted-oldest");
  });

  it("surfaces a highlighted completed item without reopening completed history inline", () => {
    const preview = getTaskPanelChecklistPreview([
      createChecklistItem({ id: "open-1" }),
      createChecklistItem({ id: "done-1", done: true, completedAt: "2026-04-17T09:00:00.000Z" }),
    ], {
      highlightId: "done-1",
    });

    expect(preview.highlightedCompletedItem?.id).toBe("done-1");
    expect(preview.openPreviewItems.map((item) => item.id)).toEqual(["open-1"]);
  });
});
