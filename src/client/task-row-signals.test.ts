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
  it("marks no known continuation without inventing a Decision, failure, or completion", () => {
    expect(getTaskAttentionSignal(task, indicator(), NOW, { activity: createTaskActivity() }))
      .toMatchObject({ kind: "needs-look", label: "Needs a look", shortLabel: "Review", tone: "faint", status: "review" });
    expect(getTaskAttentionSignal(task, indicator(), NOW))
      .toMatchObject({ kind: "status-unknown", status: "unknown" });
  });
  it("keeps normal work and dated or checked waits blank while leaving their context available", () => {
    expect(getTaskAttentionSignal(task, indicator({ busy: true, busyCount: 1 }), NOW)).toBeNull();
    expect(getTaskAttentionSignal(task, indicator({ deferCount: 1 }), NOW)).toBeNull();
    const waiting = { ...task, waitingOn: "Reviewer" };
    expect(getTaskAttentionSignal({ ...waiting, nextTouchAt: "2026-10-25T22:00:00Z" }, indicator(), NOW)).toBeNull();
    expect(getTaskAttentionSignal(waiting, indicator({ deferCount: 1 }), NOW)).toBeNull();
    expect(getTaskActivityDescription(waiting, indicator())).toBe("Waiting for: Reviewer");
    expect(getTaskActivityDescription(task, indicator(), createTaskActivity({ pendingDeliveryCount: 1 }))).toContain("queued");
  });
  it("marks a bare wait for review and says how to quiet it", () => {
    expect(getTaskAttentionSignal({ ...task, waitingOn: "Reviewer" }, indicator(), NOW, { activity: createTaskActivity() }))
      .toMatchObject({ kind: "needs-look", label: "Needs a look", detail: expect.stringContaining("Waiting for: Reviewer, with no revisit date") });
  });
  it("uses one attention mark for unread work, never a working ring", () => {
    expect(getTaskAttentionSignal(task, indicator({ busy: true, busyCount: 1, unreadCount: 1 }), NOW))
      .toMatchObject({ kind: "unread", label: "New replies", status: "unread" });
    expect(getTaskAttentionSignal(task, indicator({ needsUserInputCount: 1, unreadCount: 1 }), NOW))
      .toMatchObject({ kind: "needs-input", label: "Needs you", tone: "accent" });
  });
  it("keeps a set-aside revisit marked without silently resuming it", () => {
    const due = { ...task, deferred: true, nextTouchAt: "2000-01-01T00:00:00Z" };
    expect(getTaskAttentionSignal(due, indicator(), NOW)).toMatchObject({ label: "Revisit", status: "paused", detail: "Deferred · ready to revisit" });
    expect(getTaskAttentionSignal({ ...due, muted: true }, indicator({ needsUserInputCount: 1 }), NOW))
      .toMatchObject({ status: "paused", detail: "Muted · ready to revisit" });
    expect(getTaskAttentionSignal({ ...task, deferred: true, nextTouchAt: "9999-01-01T00:00:00Z" }, indicator(), NOW)).toBeNull();
  });
  it("draws the working spinner only when no attention mark claims the slot", () => {
    const busy = indicator({ busy: true, busyCount: 1 });
    expect(getTaskLeadingGlyph(null, busy)).toBe("working");
    expect(getTaskLeadingGlyph(null, indicator(), createTaskActivity({ runCount: 1 }))).toBe("working");
    expect(getTaskLeadingGlyph(null, indicator({ deferCount: 1 }), createTaskActivity({ deferredCount: 1 }))).toBeNull();
    expect(getTaskLeadingGlyph(getTaskAttentionSignal(task, indicator({ busy: true, busyCount: 1, unreadCount: 1 }), NOW), busy)).toBe("unread-working");
    expect(getTaskLeadingGlyph(getTaskAttentionSignal(task, indicator({ busy: true, busyCount: 1, needsUserInputCount: 1 }), NOW), busy)).toBe("needs-input");
  });});
