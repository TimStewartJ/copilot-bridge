import { describe, expect, it } from "vitest";
import {
  BACKEND_DISCONNECTED_MESSAGE,
  BACKEND_RECONNECTING_MESSAGE,
  BRIDGE_RESTARTING_MESSAGE,
  SESSION_RESUME_SETTLING_MESSAGE,
} from "../backend-availability.js";
import {
  computeDeferRetryBackoffMs,
  INITIAL_BACKOFF_MS,
  isDeferWaitError,
  MAX_BACKOFF_MS,
} from "../defer-runner-core.js";
import { PROMPT_DELIVERY_ABORTED_MESSAGE, SessionCapacityError } from "../session-manager.js";

describe("defer-runner-core delivery errors", () => {
  it.each([
    BRIDGE_RESTARTING_MESSAGE,
    PROMPT_DELIVERY_ABORTED_MESSAGE,
    BACKEND_DISCONNECTED_MESSAGE,
    BACKEND_RECONNECTING_MESSAGE,
    SESSION_RESUME_SETTLING_MESSAGE,
  ])("waits without counting a try for %s", (message) => {
    expect(isDeferWaitError(new Error(message))).toBe(true);
  });

  it.each([
    "context-limit",
    "weighted-capacity",
    "cleanup-demand",
    "retained-capacity",
    "cleanup-failed",
  ] as const)("waits without counting a try when session capacity is refused: %s", (reason) => {
    const snapshot = { contexts: 33, contextLimit: 32, localMcpInstances: 33, capacityUnits: 41.25, capacityLimit: 64 };
    expect(isDeferWaitError(new SessionCapacityError(reason, snapshot))).toBe(true);
  });

  it.each([
    "Session tool initialization did not complete before prompt delivery",
    "resumeSession timed out after 60s",
    "Session is busy processing another message",
    "Deferred worker ended without calling defer_result.",
    "Fatal delivery error",
  ])("counts %s as a failed try", (message) => {
    expect(isDeferWaitError(new Error(message))).toBe(false);
  });

  it("computes capped exponential retry backoff from the consumed attempt count", () => {
    expect(computeDeferRetryBackoffMs(1)).toBe(INITIAL_BACKOFF_MS);
    expect(computeDeferRetryBackoffMs(2)).toBe(INITIAL_BACKOFF_MS * 2);
    expect(computeDeferRetryBackoffMs(0)).toBe(INITIAL_BACKOFF_MS);
    expect(computeDeferRetryBackoffMs(100)).toBe(MAX_BACKOFF_MS);
  });
});
