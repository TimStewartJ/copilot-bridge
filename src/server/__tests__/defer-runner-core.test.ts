import { describe, expect, it } from "vitest";
import { SESSION_RESUME_SETTLING_MESSAGE } from "../backend-availability.js";
import {
  computeDeferRetryBackoffMs,
  INITIAL_BACKOFF_MS,
  isDeferWaitError,
  MAX_BACKOFF_MS,
} from "../defer-runner-core.js";

describe("defer-runner-core delivery errors", () => {
  it(`waits without counting a try for ${SESSION_RESUME_SETTLING_MESSAGE}`, () => {
    expect(isDeferWaitError(new Error(SESSION_RESUME_SETTLING_MESSAGE))).toBe(true);
  });

  it("computes capped exponential retry backoff from the consumed attempt count", () => {
    expect(computeDeferRetryBackoffMs(1)).toBe(INITIAL_BACKOFF_MS);
    expect(computeDeferRetryBackoffMs(2)).toBe(INITIAL_BACKOFF_MS * 2);
    expect(computeDeferRetryBackoffMs(0)).toBe(INITIAL_BACKOFF_MS);
    expect(computeDeferRetryBackoffMs(100)).toBe(MAX_BACKOFF_MS);
  });
});
