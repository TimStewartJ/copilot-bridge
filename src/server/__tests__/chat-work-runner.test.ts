import { describe, expect, it } from "vitest";
import { SESSION_RESUME_SETTLING_MESSAGE } from "../backend-availability.js";
import {
  computeRetryBackoffMs,
  INITIAL_BACKOFF_MS,
  isChatWorkWaitError,
  MAX_BACKOFF_MS,
} from "../chat-work-runner.js";

describe("chat work runner delivery errors", () => {
  it(`waits without counting a try for ${SESSION_RESUME_SETTLING_MESSAGE}`, () => {
    expect(isChatWorkWaitError(new Error(SESSION_RESUME_SETTLING_MESSAGE))).toBe(true);
  });

  it("computes capped exponential retry backoff from the consumed attempt count", () => {
    expect(computeRetryBackoffMs(1)).toBe(INITIAL_BACKOFF_MS);
    expect(computeRetryBackoffMs(2)).toBe(INITIAL_BACKOFF_MS * 2);
    expect(computeRetryBackoffMs(0)).toBe(INITIAL_BACKOFF_MS);
    expect(computeRetryBackoffMs(100)).toBe(MAX_BACKOFF_MS);
  });
});
