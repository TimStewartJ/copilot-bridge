import { describe, expect, it } from "vitest";
import {
  BACKEND_DISCONNECTED_MESSAGE,
  BACKEND_RECONNECTING_MESSAGE,
  SESSION_RESUME_SETTLING_MESSAGE,
} from "../backend-availability.js";
import {
  classifyDeferDeliveryError,
  computeDeferRetryBackoffMs,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from "../defer-runner-core.js";
import {
  PROMPT_DELIVERY_ABORTED_MESSAGE,
  RESTART_PENDING_MESSAGE,
} from "../session-manager.js";

describe("defer-runner-core delivery errors", () => {
  it.each([
    RESTART_PENDING_MESSAGE,
    PROMPT_DELIVERY_ABORTED_MESSAGE,
    BACKEND_DISCONNECTED_MESSAGE,
    BACKEND_RECONNECTING_MESSAGE,
    SESSION_RESUME_SETTLING_MESSAGE,
  ])("pauses without consuming an attempt for %s", (message) => {
    expect(classifyDeferDeliveryError(new Error(message))).toBe("pause");
  });

  it.each([
    "Session tool initialization did not complete before prompt delivery",
    "resumeSession timed out after 60s",
    "Session is busy processing another message",
    "Fatal delivery error",
  ])("classifies %s as retryable", (message) => {
    expect(classifyDeferDeliveryError(new Error(message))).toBe("retry");
  });

  it("computes capped exponential retry backoff from the consumed attempt count", () => {
    expect(computeDeferRetryBackoffMs(1)).toBe(INITIAL_BACKOFF_MS);
    expect(computeDeferRetryBackoffMs(2)).toBe(INITIAL_BACKOFF_MS * 2);
    expect(computeDeferRetryBackoffMs(0)).toBe(INITIAL_BACKOFF_MS);
    expect(computeDeferRetryBackoffMs(100)).toBe(MAX_BACKOFF_MS);
  });
});
