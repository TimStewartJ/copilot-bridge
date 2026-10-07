import { describe, expect, it } from "vitest";
import type { Task } from "./api";
import { getTaskRowSignals } from "./task-row-signals";
import { getTaskAlertChips } from "./components/task-momentum-alerts";

describe("native task-row meaning", () => {
  it("does not manufacture a Decision when momentum is not recorded", () => {
    const task: Task = { id: "task", title: "Existing ongoing task", kind: "ongoing", muted: false, deferred: false, status: "active",
      notes: "", priority: 0, order: 0, createdAt: "", updatedAt: "", activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0", workItems: [], pullRequests: [] };
    expect(getTaskRowSignals(task)).toEqual([]);
  });
  it("keeps deferral visible when muted and never turns a revisit or wait into danger", () => {
    const task: Task = { id: "task", title: "Set aside", kind: "task", muted: false, deferred: true, status: "active",
      notes: "", priority: 0, order: 0, createdAt: "", updatedAt: "", activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0", workItems: [], pullRequests: [],
      waitingOn: "A normal delivery", nextTouchAt: "2000-01-01T00:00:00Z" };
    // Back for its date, a set-aside task says in one badge why it surfaced and that it has not resumed.
    expect(getTaskRowSignals(task)).toEqual([
      expect.objectContaining({ kind: "follow-up-overdue", label: "Deferred · ready to revisit", shortLabel: "Revisit", status: "paused", tone: "faint" }),
    ]);
    expect(getTaskRowSignals({ ...task, muted: true })).toEqual([expect.objectContaining({ label: "Muted · ready to revisit", shortLabel: "Revisit", status: "paused" })]);
    expect(getTaskRowSignals({ ...task, nextTouchAt: "9999-01-01T00:00:00Z" })).toEqual([expect.objectContaining({ kind: "deferred", label: "Deferred" })]);
    expect(getTaskRowSignals({ ...task, muted: true, nextTouchAt: "9999-01-01T00:00:00Z" })).toEqual([expect.objectContaining({ kind: "deferred" })]);
    expect(getTaskRowSignals({ ...task, muted: true, deferred: false, nextTouchAt: undefined })).toEqual([]);
    expect(getTaskRowSignals({ ...task, deferred: false })).toEqual([expect.objectContaining({ label: "Ready to revisit", shortLabel: "Revisit", status: "open" })]);
    // The header leaves a reached date to the prompt beneath it.
    expect(getTaskAlertChips({ task })).toEqual([expect.objectContaining({ label: "Waiting for", tone: "neutral" })]);
  });
  it("marks a quiet task only when task states say so, as a faint status", () => {
    const task: Task = { id: "task", title: "Old", kind: "task", muted: false, deferred: false, status: "active",
      notes: "", priority: 0, order: 0, createdAt: "", updatedAt: "", activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0", workItems: [], pullRequests: [] };
    expect(getTaskRowSignals(task)).toEqual([]);
    expect(getTaskRowSignals(task, undefined, new Date(), { quiet: true })).toEqual([expect.objectContaining({ kind: "quiet", shortLabel: "Quiet", tone: "faint" })]);
  });
});
