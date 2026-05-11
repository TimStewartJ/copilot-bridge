import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionActivityTime,
  getSessionReadThroughActivityTime,
  getSessionRunState,
  isSessionActive,
  serializeSettingsPatch,
  type Session,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("prefers explicit merged activity over modified and start times", () => {
    expect(getSessionActivityTime({
      sessionId: "session-1",
      startTime: "2026-04-17T13:00:00.000Z",
      modifiedTime: "2026-04-17T14:00:00.000Z",
      lastVisibleActivityAt: "2026-04-17T15:00:00.000Z",
      lastAttentionAt: "2026-04-17T16:00:00.000Z",
      lastActivityAt: "2026-04-17T17:00:00.000Z",
    })).toBe("2026-04-17T17:00:00.000Z");
  });

  it("falls back to the latest visible or attention activity timestamp", () => {
    expect(getSessionActivityTime({
      sessionId: "session-1",
      startTime: "2026-04-17T13:00:00.000Z",
      modifiedTime: "2026-04-17T14:00:00.000Z",
      lastVisibleActivityAt: "2026-04-17T15:00:00.000Z",
      lastAttentionAt: "2026-04-17T16:00:00.000Z",
    })).toBe("2026-04-17T16:00:00.000Z");
  });

  it("uses visible activity when it is newer than attention activity", () => {
    expect(getSessionActivityTime({
      sessionId: "session-1",
      modifiedTime: "2026-04-17T14:00:00.000Z",
      lastVisibleActivityAt: "2026-04-17T16:00:00.000Z",
      lastAttentionAt: "2026-04-17T15:00:00.000Z",
    })).toBe("2026-04-17T16:00:00.000Z");
  });
});

describe("getSessionReadThroughActivityTime", () => {
  it("includes non-visible attention activity when a session is rendered", () => {
    expect(getSessionReadThroughActivityTime(
      {
        sessionId: "session-1",
        lastAttentionAt: "2026-05-07T21:05:00.000Z",
      },
      "2026-05-07T21:00:00.000Z",
    )).toBe("2026-05-07T21:05:00.000Z");
  });

  it("does not use visible activity that has not been rendered", () => {
    expect(getSessionReadThroughActivityTime(
      {
        sessionId: "session-1",
        lastVisibleActivityAt: "2026-05-07T21:10:00.000Z",
        lastAttentionAt: "2026-05-07T21:05:00.000Z",
      } as Session,
      "2026-05-07T21:00:00.000Z",
    )).toBe("2026-05-07T21:05:00.000Z");
  });

  it("falls back to the rendered visible cursor when attention is older", () => {
    expect(getSessionReadThroughActivityTime(
      {
        sessionId: "session-1",
        lastAttentionAt: "2026-05-07T20:55:00.000Z",
      },
      "2026-05-07T21:00:00.000Z",
    )).toBe("2026-05-07T21:00:00.000Z");
  });
});

describe("serializeSettingsPatch", () => {
  it("preserves explicit model clears", () => {
    expect(serializeSettingsPatch({ model: undefined })).toBe(
      JSON.stringify({ model: "" }),
    );
  });

  it("preserves explicit reasoning effort clears", () => {
    expect(serializeSettingsPatch({ reasoningEffort: undefined })).toBe(
      JSON.stringify({ reasoningEffort: "" }),
    );
  });

  it("leaves other setting updates unchanged", () => {
    expect(serializeSettingsPatch({ theme: "dark", model: "gpt-5.4", reasoningEffort: "high" })).toBe(
      JSON.stringify({ theme: "dark", model: "gpt-5.4", reasoningEffort: "high" }),
    );
  });
});
