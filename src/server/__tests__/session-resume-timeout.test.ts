import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_RESUME_TIMEOUT_MS, resumeSessionWithTimeout } from "../session-resume-timeout.js";

describe("resumeSessionWithTimeout", () => {
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

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
    const session = { sessionId: "session-2", disconnect: vi.fn() };
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
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    // A resume that wins the race is owned by the caller and must not be disconnected here.
    expect(session.disconnect).not.toHaveBeenCalled();
  });

  it("disconnects a session that resolves after the timeout", async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const session = { sessionId: "late", disconnect };
    let resolveResume!: (value: typeof session) => void;
    const resume = new Promise<typeof session>((resolve) => {
      resolveResume = resolve;
    });

    const result = resumeSessionWithTimeout(resume, "resumeSession timed out after 60s");
    const rejection = expect(result).rejects.toThrow("resumeSession timed out after 60s");
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_TIMEOUT_MS);
    await rejection;

    resolveResume(session);
    await flush();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("uses a custom disconnectLateSession hook for late resolves", async () => {
    vi.useFakeTimers();
    const disconnectLateSession = vi.fn().mockResolvedValue(undefined);
    const session = { sessionId: "late-custom" };
    let resolveResume!: (value: typeof session) => void;
    const resume = new Promise<typeof session>((resolve) => {
      resolveResume = resolve;
    });

    const result = resumeSessionWithTimeout(
      resume,
      "resumeSession timed out after 60s",
      SESSION_RESUME_TIMEOUT_MS,
      { disconnectLateSession },
    );
    const rejection = expect(result).rejects.toThrow("resumeSession timed out after 60s");
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_TIMEOUT_MS);
    await rejection;

    resolveResume(session);
    await flush();

    expect(disconnectLateSession).toHaveBeenCalledTimes(1);
    expect(disconnectLateSession).toHaveBeenCalledWith(session);
  });

  it("observes a late rejection without disconnecting", async () => {
    vi.useFakeTimers();
    const onLateError = vi.fn();
    const disconnect = vi.fn();
    let rejectResume!: (error: unknown) => void;
    const resume = new Promise<{ disconnect: typeof disconnect }>((_, reject) => {
      rejectResume = reject;
    });

    const result = resumeSessionWithTimeout(
      resume,
      "resumeSession timed out after 60s",
      SESSION_RESUME_TIMEOUT_MS,
      { onLateError },
    );
    const rejection = expect(result).rejects.toThrow("resumeSession timed out after 60s");
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_TIMEOUT_MS);
    await rejection;

    const lateError = new Error("late resume failure");
    rejectResume(lateError);
    await flush();

    expect(onLateError).toHaveBeenCalledWith(lateError);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("routes a late disconnect failure to onLateError and keeps the timeout rejection", async () => {
    vi.useFakeTimers();
    const onLateError = vi.fn();
    const disconnectError = new Error("disconnect failed");
    const disconnect = vi.fn().mockRejectedValue(disconnectError);
    const session = { sessionId: "late-fail", disconnect };
    let resolveResume!: (value: typeof session) => void;
    const resume = new Promise<typeof session>((resolve) => {
      resolveResume = resolve;
    });

    const result = resumeSessionWithTimeout(
      resume,
      "resumeSession timed out after 60s",
      SESSION_RESUME_TIMEOUT_MS,
      { onLateError },
    );
    const rejection = expect(result).rejects.toThrow("resumeSession timed out after 60s");
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_TIMEOUT_MS);
    await rejection;

    resolveResume(session);
    await flush();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onLateError).toHaveBeenCalledWith(disconnectError);
  });
});
