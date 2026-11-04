import { describe, expect, it } from "vitest";
import { getLastHostResume, HOST_SUSPEND_GAP_MS, noteTimerDelay } from "../host-suspend.js";

describe("host suspend tracking", () => {
  it("remembers the most recent wake and how long the host slept", () => {
    noteTimerDelay(HOST_SUSPEND_GAP_MS, 2_000_000);
    expect(getLastHostResume()).toEqual({ resumedAtMs: 2_000_000, sleptMs: HOST_SUSPEND_GAP_MS });
    noteTimerDelay(8 * 60 * 60_000, 3_000_000);
    noteTimerDelay(HOST_SUSPEND_GAP_MS - 1, 3_000_200);
    expect(getLastHostResume()).toEqual({ resumedAtMs: 3_000_000, sleptMs: 8 * 60 * 60_000 });
  });
});
