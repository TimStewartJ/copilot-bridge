import { describe, expect, it } from "vitest";
import { describeMomentumStamp, momentumAgeFields, nextStepUnverified, type MomentumFieldStamp } from "./momentum-age.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const agent = (at: string, extra: Partial<MomentumFieldStamp> = {}): MomentumFieldStamp => ({ at, source: "agent", sessionId: "s-1", ...extra });

describe("momentum age", () => {
  it.each([
    { stamp: agent(ago(5 * 24 * HOUR + HOUR)), text: "set 5d ago by session s-1" },
    { stamp: agent(ago(3 * HOUR), { scheduleName: "Morning sweep" }), text: "set 3h ago by schedule \"Morning sweep\" (session s-1)" },
    { stamp: agent(ago(10_000), { sessionId: undefined }), text: "set just now by an agent" },
    { stamp: { at: ago(2 * 24 * HOUR), source: "user" as const }, text: "set 2d ago by the user" },
    { stamp: { at: ago(24 * HOUR), source: "system" as const }, text: "set 1d ago by Bridge" },
    { stamp: agent("not a date"), text: "set at an unknown time" },
    { stamp: null, text: "set at an unknown time" },
  ])("describes $text", ({ stamp, text }) => {
    expect(describeMomentumStamp(stamp, NOW)).toBe(text);
  });

  it("leaves the session out when asked", () => {
    expect(describeMomentumStamp(agent(ago(HOUR), { scheduleName: "Sweep" }), NOW, { sessions: false })).toBe("set 1h ago by schedule \"Sweep\"");
  });

  it.each([
    { label: "just under 3 days", stamp: agent(ago(3 * 24 * HOUR - 60_000)), unverified: false },
    { label: "just over 3 days", stamp: agent(ago(3 * 24 * HOUR + 60_000)), unverified: true },
    { label: "no record", stamp: null, unverified: true },
    { label: "an unreadable time", stamp: agent("garbage"), unverified: true },
    { label: "a Bridge that sends no stamps", stamp: undefined, unverified: false },
  ])("marks a next step of $label unverified: $unverified", ({ stamp, unverified }) => {
    expect(nextStepUnverified(stamp, NOW)).toBe(unverified);
  });

  it("marks only a task on the user, and only fields the task has", () => {
    const old = agent(ago(5 * 24 * HOUR));
    const task = { nextAction: "Draft the ask", nextActionSet: old, waitingOnSet: null };
    expect(momentumAgeFields(task, NOW, { onYou: true })).toEqual({ nextActionSet: "set 5d ago by session s-1", nextActionUnverified: true });
    expect(momentumAgeFields(task, NOW)).toEqual({ nextActionSet: "set 5d ago by session s-1" });
    expect(momentumAgeFields({ nextAction: "Draft the ask" }, NOW, { onYou: true })).toEqual({});
  });
});
