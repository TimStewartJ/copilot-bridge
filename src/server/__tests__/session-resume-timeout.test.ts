import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_RESUME_TIMEOUT_MS, resumeSessionWithTimeout } from "../session-resume-timeout.js";

describe("resumeSessionWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the resumed session", async () => {
    vi.useFakeTimers();
    const session = { sessionId: "session-1" };

    await expect(
      resumeSessionWithTimeout(Promise.resolve(session), "resumeSession timed out after 60s"),
    ).resolves.toBe(session);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the supplied timeout message after the resume timeout", async () => {
    vi.useFakeTimers();
    const resume = new Promise<never>(() => {});
    const result = resumeSessionWithTimeout(resume, "name resume timed out after 60s");
    const rejection = expect(result).rejects.toThrow("name resume timed out after 60s");

    await vi.advanceTimersByTimeAsync(SESSION_RESUME_TIMEOUT_MS);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout timer when resume settles before the deadline", async () => {
    vi.useFakeTimers();
    const session = { sessionId: "session-2" };
    let resolveResume!: (value: typeof session) => void;
    const resume = new Promise<typeof session>((resolve) => {
      resolveResume = resolve;
    });
    const result = resumeSessionWithTimeout(resume, "resumeSession timed out after 60s");

    expect(vi.getTimerCount()).toBe(1);
    resolveResume(session);

    await expect(result).resolves.toBe(session);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(SESSION_RESUME_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
