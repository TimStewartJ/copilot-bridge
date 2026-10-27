import { describe, expect, it } from "vitest";
import { isHelmReplyUnread } from "./home-mark";

const READ_THROUGH = "2026-09-18T09:00:00.000Z";
const isUnread = (_sessionId: string, activityTime?: string) => !!activityTime && activityTime > READ_THROUGH;
const reply = (overrides: Partial<{ lastReplyAt: string | null; handsFree: boolean }> = {}) => ({
  sessionId: "helm-1", lastReplyAt: "2026-09-18T09:05:00.000Z", handsFree: false, ...overrides,
});

describe("isHelmReplyUnread", () => {
  it.each([
    ["a reply after the read point", reply(), true, true],
    ["a reply already read", reply({ lastReplyAt: "2026-09-18T08:55:00.000Z" }), true, false],
    ["no reply yet", reply({ lastReplyAt: null }), true, false],
    ["hands-free is reading it out", reply({ handsFree: true }), true, false],
    ["read state not loaded yet", reply(), false, false],
    ["no current conversation", null, true, false],
  ])("%s", (_label, current, hydrated, expected) => {
    expect(isHelmReplyUnread(current, hydrated, isUnread)).toBe(expected);
  });
});
