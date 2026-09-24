import { describe, expect, it } from "vitest";
import { deriveTaskState, latestTime, type TaskStateInput } from "./task-state.js";

const NOW = Date.parse("2026-09-23T20:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const base = (overrides: Partial<TaskStateInput> = {}): TaskStateInput => ({
  muted: false, deferred: false, busyCount: 0, stalledCount: 0, inputCount: 0, automationCount: 0,
  lastEngagedAt: daysAgo(10), ...overrides,
});

describe("deriveTaskState", () => {
  it.each([
    ["recently engaged", base({ lastEngagedAt: daysAgo(2) }), "in_motion"],
    ["agent working on an old task", base({ lastEngagedAt: daysAgo(90), busyCount: 1 }), "in_motion"],
    ["waiting, engaged 10 days ago", base({ waitingOn: "A reply" }), "waiting"],
    ["next step, engaged 10 days ago", base({ nextAction: "Draft" }), "up_next"],
    ["nothing recorded", base(), "no_next_step"],
    ["untouched for a month", base({ lastEngagedAt: daysAgo(30), nextAction: "Draft" }), "gone_quiet"],
    ["unknown engagement", base({ lastEngagedAt: undefined }), "gone_quiet"],
    ["quiet but a revisit is planned", base({ lastEngagedAt: daysAgo(60), nextTouchAt: daysAgo(-5) }), "waiting"],
    ["quiet but automation still runs", base({ lastEngagedAt: daysAgo(60), automationCount: 1 }), "no_next_step"],
    ["quiet but its conversations could not be read", base({ lastEngagedAt: daysAgo(60), nextAction: "Draft", sessionSignalsUnknown: true }), "up_next"],
    ["revisit planned, nothing else", base({ nextTouchAt: daysAgo(-3) }), "waiting"],
    ["deferred", base({ deferred: true, lastEngagedAt: daysAgo(1) }), "set_aside"],
    ["muted", base({ muted: true, inputCount: 2 }), "set_aside"],
  ] as const)("%s → %s", (_label, input, state) => {
    expect(deriveTaskState(input, NOW).state).toBe(state);
  });

  it("puts questions, stalls and reached revisits first, deferred or not, and ignores the checklist entirely", () => {
    expect(deriveTaskState(base({ inputCount: 1, stalledCount: 1, nextTouchAt: daysAgo(1) }), NOW))
      .toMatchObject({ state: "needs_you", reasons: ["question", "stalled", "revisit"] });
    expect(deriveTaskState(base({ deferred: true, nextTouchAt: daysAgo(0) }), NOW)).toMatchObject({ state: "needs_you", reasons: ["revisit"] });
    // The rules take no checklist input at all, so overdue to-dos can never change a task's state.
    expect(Object.keys(base()).some(key => /checklist|deadline|action(?!Count)/i.test(key) && key !== "nextAction")).toBe(false);
  });

  it("flags a long wait without making it urgent", () => {
    expect(deriveTaskState(base({ waitingOn: "Review", lastEngagedAt: daysAgo(22) }), NOW)).toMatchObject({ state: "waiting", staleWait: true, idleDays: 22 });
    expect(deriveTaskState(base({ waitingOn: "Review", lastEngagedAt: daysAgo(45) }), NOW)).toMatchObject({ state: "gone_quiet", staleWait: true });
    expect(deriveTaskState(base({ waitingOn: "Review", lastEngagedAt: daysAgo(3) }), NOW).staleWait).toBe(false);
    expect(deriveTaskState(base({ waitingOn: "Review", lastEngagedAt: daysAgo(25), waitingSince: daysAgo(4) }), NOW).staleWait).toBe(false);
    expect(deriveTaskState(base({ waitingOn: "Review", lastEngagedAt: daysAgo(25), nextTouchAt: daysAgo(-7) }), NOW).staleWait).toBe(false);
  });

  it("picks the latest valid timestamp", () => {
    expect(latestTime(undefined, "bad", daysAgo(5), daysAgo(1), null)).toBe(daysAgo(1));
    expect(latestTime(undefined, null)).toBeUndefined();
  });
});
