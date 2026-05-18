import { afterEach, describe, expect, it, vi } from "vitest";
import { runValidationGate, type ValidationGate } from "../validation-pipeline.js";

const TEST_GATE: ValidationGate = {
  id: "timed",
  label: "Timed validation",
  steps: [
    { command: "first", timeoutMs: 1_000 },
    { command: "second", timeoutMs: 1_000 },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("validation pipeline timing", () => {
  it("records step durations and logs gate timing", () => {
    vi.useFakeTimers({ now: 0 });
    const log = vi.fn();
    const result = runValidationGate(TEST_GATE, {
      cwd: "/repo",
      log,
      run: (command) => {
        vi.advanceTimersByTime(command === "first" ? 250 : 1_250);
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.results.map((entry) => entry.elapsedMs)).toEqual([250, 1_250]);
    expect(log).toHaveBeenCalledWith("Timed validation step 1/2 passed in 250ms: first");
    expect(log).toHaveBeenCalledWith("Timed validation step 2/2 passed in 1.3s: second");
    expect(log).toHaveBeenCalledWith(
      "Completed timed validation in 1.5s (1. first 250ms; 2. second 1.3s)",
    );
  });

  it("logs failing step duration before returning the failure", () => {
    vi.useFakeTimers({ now: 0 });
    const log = vi.fn();
    const result = runValidationGate(TEST_GATE, {
      cwd: "/repo",
      log,
      run: (command) => {
        vi.advanceTimersByTime(command === "first" ? 500 : 2_000);
        return { ok: command === "first" };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.results.map((entry) => entry.elapsedMs)).toEqual([500, 2_000]);
    expect(log).toHaveBeenCalledWith("Timed validation step 2/2 failed after 2.0s: second");
  });
});
