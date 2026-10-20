import { describe, expect, it } from "vitest";
import { deriveTaskAttention, type TaskAttentionInput, type TaskActivity } from "./task-attention.js";
import { createTaskActivity } from "../test-support/task-attention.js";

const NOW = Date.parse("2026-10-19T22:00:00Z");
const input = (overrides: Partial<TaskAttentionInput> = {}): TaskAttentionInput => ({
  active: true, muted: false, deferred: false, inputCount: 0, unreadCount: 0,
  readStateKnown: true, sessionStateKnown: true, liveWorkCount: 0, activity: createTaskActivity(), ...overrides,
});

describe("task attention", () => {
  it("marks known inactivity even after the last reply is read, without requiring a time threshold", () => {
    expect(deriveTaskAttention(input({ unreadCount: 1 }), NOW)).toBe("unread");
    expect(deriveTaskAttention(input({ unreadCount: 0 }), NOW)).toBe("review");
    expect(deriveTaskAttention(input(), NOW + 90 * 86_400_000)).toBe("review");
    expect(deriveTaskAttention(input(), NOW)).not.toBe("stalled");
  });

  it.each([
    "runCount", "runningAgentCount", "runningCommandCount", "heldCount", "externalCount",
    "deferredCount", "scheduledCount", "pendingDeliveryCount", "managementJobCount",
  ] satisfies Array<keyof Omit<TaskActivity, "known">>)("keeps %s unmarked without losing an explicit request", (key) => {
    const activity = createTaskActivity({ [key]: 1 });
    expect(deriveTaskAttention(input({ activity }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ activity, inputCount: 1 }), NOW)).toBe("needs-input");
    expect(deriveTaskAttention(input({ activity, unreadCount: 1 }), NOW)).toBe("unread");
  });

  it("keeps dated or checked waits and future revisits quiet, marks a bare wait, and marks reached dates", () => {
    expect(deriveTaskAttention(input({ waitingOn: "Reviewer approval" }), NOW)).toBe("review");
    expect(deriveTaskAttention(input({ waitingOn: "Reviewer approval", nextTouchAt: "2026-10-20T22:00:00Z" }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ waitingOn: "Reviewer approval", activity: createTaskActivity({ deferredCount: 1 }) }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ waitingOn: "Reviewer approval", liveWorkCount: 1 }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ nextTouchAt: "2026-10-20T22:00:00Z" }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ nextTouchAt: "2026-10-19T22:00:00Z" }), NOW)).toBe("revisit");
  });

  it("does not turn missing or invalid evidence into either known inactivity or a healthy blank", () => {
    for (const overrides of [
      { activity: undefined }, { activity: createTaskActivity({ known: false }) },
      { readStateKnown: false }, { sessionStateKnown: false }, { nextTouchAt: "not a date" },
      { sessionStateKnown: false, waitingOn: "Reviewer" },
      { activity: createTaskActivity({ runningCommandCount: Number.NaN }) },
    ]) expect(deriveTaskAttention(input(overrides), NOW)).toBe("unavailable");
    expect(deriveTaskAttention(input({ liveWorkCount: 1, activity: undefined }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ activity: createTaskActivity({ known: false, scheduledCount: 1 }) }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ activity: createTaskActivity({ known: false, sessionIndexKnown: false, scheduledCount: 1 }) }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ readStateKnown: false, sessionStateKnown: false, liveWorkCount: 1 }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ readStateKnown: false, nextTouchAt: "2026-10-20T22:00:00Z" }), NOW)).toBeNull();
  });

  it("suppresses review on parked, muted and closed tasks without hiding new unmuted replies", () => {
    expect(deriveTaskAttention(input({ deferred: true }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ muted: true }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ active: false }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ active: false, unreadCount: 1 }), NOW)).toBe("unread");
    expect(deriveTaskAttention(input({ active: false, inputCount: 1 }), NOW)).toBe("needs-input");
    expect(deriveTaskAttention(input({ muted: true, inputCount: 1, unreadCount: 1 }), NOW)).toBeNull();
    expect(deriveTaskAttention(input({ muted: true, nextTouchAt: "2026-10-18T00:00:00Z" }), NOW)).toBe("revisit");
  });
});
