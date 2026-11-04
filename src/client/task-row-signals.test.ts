import { describe, expect, it } from "vitest";
import type { Task } from "./api";
import type { TaskIndicator } from "./hooks/useTaskIndicators";
import { getTaskActivityDescription, getTaskAttentionSignal, getTaskLeadingGlyph } from "./task-row-signals";
import { createTaskActivity } from "../test-support/task-attention";

const task: Task = { id: "task", title: "Existing ongoing task", kind: "ongoing", muted: false, deferred: false, status: "active",
  notes: "", priority: 0, order: 0, createdAt: "", updatedAt: "", activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0", workItems: [], pullRequests: [] };
const indicator = (overrides: Partial<TaskIndicator> = {}): TaskIndicator => ({
  busy: false, stalled: false, unread: false, busyCount: 0, unreadCount: 0, lastActivity: "",
  readStateKnown: true, sessionStateKnown: true, ...overrides,
});
const NOW = new Date("2026-10-19T22:00:00Z");

describe("attention-only task rows", () => {
  it("keeps normal work and dated or checked waits blank while leaving their context available", () => {
    expect(getTaskAttentionSignal(task, indicator({ busy: true, busyCount: 1 }), NOW)).toBeNull();
    expect(getTaskAttentionSignal(task, indicator({ deferCount: 1 }), NOW)).toBeNull();
    const waiting = { ...task, waitingOn: "Reviewer" };
    const review = getTaskAttentionSignal(waiting, indicator(), NOW, { activity: createTaskActivity() });
    expect(review).toMatchObject({ kind: "needs-look", detail: expect.stringContaining("Reviewer") });
    expect(review?.detail).toMatch(/\brevisit\b/i);
    expect(review?.detail).toMatch(/\b(add|set|choose|schedule)\b/i);
    expect(getTaskAttentionSignal({ ...waiting, nextTouchAt: "2026-10-25T22:00:00Z" }, indicator(), NOW)).toBeNull();
    expect(getTaskAttentionSignal(waiting, indicator({ deferCount: 1 }), NOW)).toBeNull();
    expect(getTaskActivityDescription(waiting, indicator())).toBe("Waiting for: Reviewer");
    expect(getTaskActivityDescription(task, indicator(), createTaskActivity({ pendingDeliveryCount: 1 }))).toContain("queued");
  });
  it("keeps a set-aside revisit marked without silently resuming it", () => {
    const due = { ...task, deferred: true, nextTouchAt: "2000-01-01T00:00:00Z" };
    expect(getTaskAttentionSignal(due, indicator({ busy: true, busyCount: 1 }), NOW)).toMatchObject({ label: "Revisit", status: "paused", detail: "Deferred · ready to revisit" });
    expect(getTaskAttentionSignal({ ...due, muted: true }, indicator({ needsUserInputCount: 1 }), NOW))
      .toMatchObject({ status: "paused", detail: "Muted · ready to revisit" });
    expect(getTaskAttentionSignal({ ...task, deferred: true, nextTouchAt: "9999-01-01T00:00:00Z" }, indicator(), NOW)).toBeNull();
  });
  it("draws the working spinner only when no attention mark claims the slot", () => {
    const busy = indicator({ busy: true, busyCount: 1 });
    expect(getTaskLeadingGlyph(null, busy)).toBe("working");
    expect(getTaskLeadingGlyph(null, indicator(), createTaskActivity({ runCount: 1 }))).toBe("working");
    expect(getTaskLeadingGlyph(null, indicator({ deferCount: 1 }), createTaskActivity({ deferredCount: 1 }))).toBeNull();
    const unread = getTaskAttentionSignal(task, { ...busy, unreadCount: 1 }, NOW);
    const question = getTaskAttentionSignal(task, { ...busy, unreadCount: 1, needsUserInputCount: 1 }, NOW);
    expect(unread).toMatchObject({ kind: "unread", status: "unread" });
    expect(question).toMatchObject({ kind: "needs-input", status: "needs-input" });
    expect(getTaskLeadingGlyph(unread, busy)).toBe("unread-working");
    expect(getTaskLeadingGlyph(question, busy)).toBe("needs-input");
  });
});
