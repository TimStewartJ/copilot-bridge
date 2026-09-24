import { describe, expect, it } from "vitest";
import type { Task } from "./api";
import { getTaskRowSignals } from "./task-row-signals";
import { getTaskAlertChips } from "./components/task-momentum-alerts";

describe("native task-row meaning", () => {
  it("does not manufacture a Decision when momentum is not recorded", () => {
    const task: Task = { id: "task", title: "Existing ongoing task", kind: "ongoing", muted: false, deferred: false, status: "active",
      notes: "", priority: 0, order: 0, createdAt: "", updatedAt: "", sessionIds: [], workItems: [], pullRequests: [] };
    expect(getTaskRowSignals(task)).toEqual([]);
  });
  it("keeps deferral visible when muted and never turns a revisit or wait into danger", () => {
    const task: Task = { id: "task", title: "Set aside", kind: "task", muted: false, deferred: true, status: "active",
      notes: "", priority: 0, order: 0, createdAt: "", updatedAt: "", sessionIds: [], workItems: [], pullRequests: [],
      waitingOn: "A normal delivery", nextTouchAt: "2000-01-01T00:00:00Z" };
    expect(getTaskRowSignals(task)).toEqual([
      expect.objectContaining({ kind: "deferred", label: "Deferred", tone: "faint" }),
      expect.objectContaining({ label: "Ready to revisit", tone: "faint" }),
    ]);
    expect(getTaskRowSignals({ ...task, muted: true })).toEqual([expect.objectContaining({ kind: "deferred" })]);
    expect(getTaskAlertChips({ task, sessions: [] })).toEqual([
      expect.objectContaining({ label: "Ready to revisit", tone: "neutral" }),
      expect.objectContaining({ label: "Waiting for", tone: "neutral" }),
    ]);
  });
  it("marks a quiet task only when task states say so, as a faint status", () => {
    const task: Task = { id: "task", title: "Old", kind: "task", muted: false, deferred: false, status: "active",
      notes: "", priority: 0, order: 0, createdAt: "", updatedAt: "", sessionIds: [], workItems: [], pullRequests: [] };
    expect(getTaskRowSignals(task)).toEqual([]);
    expect(getTaskRowSignals(task, undefined, new Date(), { quiet: true })).toEqual([expect.objectContaining({ kind: "quiet", shortLabel: "Quiet", tone: "faint" })]);
  });
});
