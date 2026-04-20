import { describe, expect, it } from "vitest";
import { getSessionActivityTime, getSessionRunState, isSessionActive, type Session } from "./api";

describe("session run-state helpers", () => {
  it("prefers explicit runState over legacy busy flags", () => {
    const session = { sessionId: "session-1", runState: "stalled", busy: false } satisfies Partial<Session>;

    expect(getSessionRunState(session)).toBe("stalled");
    expect(isSessionActive(session)).toBe(true);
  });

  it("falls back to busy/idle when runState is absent", () => {
    expect(getSessionRunState({ sessionId: "busy-session", busy: true })).toBe("busy");
    expect(getSessionRunState({ sessionId: "idle-session", busy: false })).toBe("idle");
  });
});

describe("getSessionActivityTime", () => {
  it("prefers the latest visible activity timestamp over modified and start times", () => {
    expect(getSessionActivityTime({
      sessionId: "session-1",
      startTime: "2026-04-17T13:00:00.000Z",
      modifiedTime: "2026-04-17T14:00:00.000Z",
      lastVisibleActivityAt: "2026-04-17T15:00:00.000Z",
    })).toBe("2026-04-17T15:00:00.000Z");
  });
});
