import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createRestartSuspendedSessionStore } from "../restart-suspended-session-store.js";

describe("restart suspended session store", () => {
  it("records and clears restart recovery records", () => {
    const store = createRestartSuspendedSessionStore(setupTestDb());

    store.upsertSuspending({
      sessionId: "session-1",
      runKind: "message",
      pendingPrompt: "hello",
      promptAccepted: true,
      suspendedAt: "2026-05-19T17:00:00.000Z",
      lastEventAt: "2026-05-19T17:00:01.000Z",
    });
    store.markSuspended("session-1", "2026-05-19T17:00:02.000Z");

    expect(store.get("session-1")).toMatchObject({
      sessionId: "session-1",
      runKind: "message",
      pendingPrompt: "hello",
      promptAccepted: true,
      suspendedAt: "2026-05-19T17:00:02.000Z",
      lastEventAt: "2026-05-19T17:00:01.000Z",
      status: "suspended",
      resumeAttempts: 0,
    });

    store.markResuming("session-1");
    expect(store.listRecoverable()).toMatchObject([
      { sessionId: "session-1", status: "resuming", resumeAttempts: 1 },
    ]);

    store.delete("session-1");
    expect(store.listAll()).toEqual([]);
  });

  it("excludes records that exhausted resume attempts", () => {
    const store = createRestartSuspendedSessionStore(setupTestDb());

    store.upsertSuspending({
      sessionId: "session-1",
      runKind: "message",
      promptAccepted: true,
      suspendedAt: "2026-05-19T17:00:00.000Z",
    });
    store.markSuspended("session-1");
    store.markResuming("session-1");
    store.markResuming("session-1");
    store.markResuming("session-1");

    expect(store.get("session-1")?.resumeAttempts).toBe(3);
    expect(store.listRecoverable()).toEqual([]);
    expect(store.listRecoverable(4)).toHaveLength(1);
  });
});
