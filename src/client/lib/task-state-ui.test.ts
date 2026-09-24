import { describe, expect, it } from "vitest";
import type { TaskOverviewRow } from "../../shared/task-overview";
import { contextLine, describeIdle, describeTouch, formatSpan, KEEP_DAYS, needsYouCount, outcomePatches, setAsideAttention, setAsidePatches, stateBadge } from "./task-state-ui";
import { groupHomeChecklistByDate } from "../components/HomeChecklist";

const NOW = new Date("2026-09-22T12:00:00Z");
const row = (overrides: Partial<TaskOverviewRow> = {}): TaskOverviewRow => ({ id: "t", title: "Task", kind: "task", muted: false, deferred: false,
  state: "up_next", reasons: [], staleWait: false, idleDays: 10, busyCount: 0, stalledCount: 0, inputCount: 0, automationCount: 0, order: 0, ...overrides });

describe("task state wording", () => {
  it("says spans and idle time the way a person would", () => {
    expect(formatSpan(1)).toBe("1 day");
    expect(formatSpan(13)).toBe("13 days");
    expect(formatSpan(35)).toBe("5 weeks");
    expect(formatSpan(120)).toBe("4 months");
    expect(describeIdle({ idleDays: 0 })).toBe("today");
    expect(describeIdle({ idleDays: 1 })).toBe("yesterday");
    expect(describeIdle({ idleDays: null })).toBe("No recent activity from you");
  });
  it("gives one context line from momentum, preferring a question about an old wait", () => {
    expect(contextLine(row({ nextAction: "Call", waitingOn: "Sam" }))).toEqual({ text: "Next: Call", empty: false });
    expect(contextLine(row({ waitingOn: "Sam" }))).toEqual({ text: "Waiting for: Sam", empty: false });
    expect(contextLine(row({ waitingOn: "The vendor reply.", staleWait: true }))).toEqual({ text: "Still waiting for the vendor reply?", empty: false });
    expect(contextLine(row({ deferred: true, nextAction: "Call" })).text).toBe("When resumed: Call");
    expect(contextLine(row())).toEqual({ text: "No next step", empty: true });
  });
  it("picks the single most useful badge", () => {
    expect(stateBadge(row({ inputCount: 1, busyCount: 1 }), NOW)).toEqual({ label: "Answer needed", tone: "warning" });
    expect(stateBadge(row({ busyCount: 1 }), NOW)).toEqual({ label: "Agent working", tone: "info" });
    expect(stateBadge(row({ state: "set_aside", muted: true }), NOW)).toEqual({ label: "Muted", tone: "neutral" });
    expect(stateBadge(row({ state: "gone_quiet" }), NOW)).toEqual({ label: "Quiet", tone: "neutral" });
    expect(stateBadge(row(), NOW)).toBeNull();
  });
});

describe("quiet-task outcomes", () => {
  const prior = row({ deferred: true, nextAction: "Draft", waitingOn: "Sam", nextTouchAt: "2026-01-01T00:00:00.000Z" });
  it("undoes finishing or archiving by restoring every field completion clears", () => {
    const restore = { status: "active", deferred: true, nextAction: "Draft", waitingOn: "Sam", nextTouchAt: "2026-01-01T00:00:00.000Z" };
    expect(outcomePatches(prior, "finished")).toEqual({ apply: { completionAction: "complete-and-archive" }, undo: restore });
    expect(outcomePatches(prior, "archive")).toEqual({ apply: { status: "archived" }, undo: restore });
    expect(outcomePatches(row(), "archive").undo).toMatchObject({ nextAction: null, waitingOn: null, nextTouchAt: null, deferred: false });
  });
  it("keeps a task by moving its revisit out, and undoes only that", () => {
    const { apply, undo } = outcomePatches(prior, "keep", NOW.getTime());
    expect(apply).toEqual({ nextTouchAt: new Date(NOW.getTime() + KEEP_DAYS * 86_400_000).toISOString() });
    expect(undo).toEqual({ nextTouchAt: "2026-01-01T00:00:00.000Z" });
  });
  it("sets aside with an optional revisit and restores both", () => {
    expect(setAsidePatches(row({ nextTouchAt: "2026-01-01T00:00:00.000Z" }), "2026-10-01T09:00:00.000Z")).toEqual({
      apply: { deferred: true, nextTouchAt: "2026-10-01T09:00:00.000Z" }, undo: { deferred: false, nextTouchAt: "2026-01-01T00:00:00.000Z" } });
  });
});

describe("checklist by due date", () => {
  it("buckets to-dos by when they are due and keeps order within a bucket", () => {
    const items = [
      { id: "none", taskId: null, text: "Undated" },
      { id: "late", taskId: null, text: "Late", deadline: "2026-09-20" },
      { id: "today", taskId: null, text: "Today", deadline: "2026-09-22" },
      { id: "soon", taskId: null, text: "Soon", deadline: "2026-10-06" },
      { id: "later", taskId: null, text: "Later", deadline: "2026-10-07" },
      { id: "late2", taskId: null, text: "Later late", deadline: "2026-09-21" },
    ];
    expect(groupHomeChecklistByDate(items, "2026-09-22").map(bucket => [bucket.label, bucket.items.map(item => item.id)])).toEqual([
      ["Overdue", ["late", "late2"]], ["Due today", ["today"]], ["Next two weeks", ["soon"]], ["Later", ["later"]], ["No date", ["none"]],
    ]);
    expect(groupHomeChecklistByDate([], "2026-09-22")).toEqual([]);
  });
});

describe("set-aside tasks that still need Tim", () => {
  it("names only set-aside tasks in Needs you, with their reason", () => {
    const rows = [
      row({ id: "asks", state: "needs_you", reasons: ["question"], inputCount: 1, deferred: true }),
      row({ id: "due", state: "needs_you", reasons: ["revisit"], nextTouchAt: "2026-09-20T00:00:00.000Z", deferred: true }),
      row({ id: "working", state: "needs_you", reasons: ["stalled"], stalledCount: 1 }),
      row({ id: "resting", state: "set_aside", deferred: true }),
    ];
    const result = setAsideAttention(rows, new Set(["asks", "due", "resting"]), NOW);
    expect([...result.keys()]).toEqual(["asks", "due"]);
    expect(result.get("asks")).toBe("Answer needed");
    expect(result.get("due")).toMatch(/^Revisit · /);
    expect(needsYouCount(1)).toBe("1 needs you");
    expect(needsYouCount(2)).toBe("2 need you");
  });
  it("says what the last touch was", () => {
    expect(describeTouch(row({ idleDays: 21, lastTouchKind: "message" }))).toBe("You wrote in its conversation 3 weeks ago");
    expect(describeTouch(row({ idleDays: 0, lastTouchKind: "edited" }))).toBe("You edited it today");
    expect(describeTouch(row({ idleDays: null }))).toBe("No recent activity from you");
  });
});
