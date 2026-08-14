import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteDbEntryPage,
  createSession,
  createTaskSession,
  getSessionActivityTime,
  getSessionReadThroughActivityTime,
  getSessionRunState,
  isSessionActive,
  serializeSettingsPatch,
  updateDbEntryPage,
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

  it("preserves an explicit remembered-family clear", () => {
    expect(serializeSettingsPatch({ lastModelFamily: undefined })).toBe(
      JSON.stringify({ lastModelFamily: "" }),
    );
  });

  describe("session creation client API", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubSessionResponse(sessionId: string) {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ sessionId }),
      })));
    }

    it("sends explicit model, effort, and context for a new quick chat", async () => {
      stubSessionResponse("session-1");

      await expect(createSession({
        model: "gpt-5.6",
        reasoningEffort: "high",
        contextTier: "long_context",
      })).resolves.toBe("session-1");

      expect(vi.mocked(fetch).mock.calls[0]).toEqual([
        "/api/sessions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            model: "gpt-5.6",
            reasoningEffort: "high",
            contextTier: "long_context",
          }),
        }),
      ]);
    });

    it("omits a blank model override for a task session", async () => {
      stubSessionResponse("task-session");

      await expect(createTaskSession("task-1", { model: "" })).resolves.toBe("task-session");

      expect(vi.mocked(fetch).mock.calls[0]).toEqual([
        "/api/tasks/task-1/session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        }),
      ]);
    });

    it("sends the selected agent definition for a new task chat", async () => {
      stubSessionResponse("task-session");

      await expect(createTaskSession("task-1", {
        agent: "implementation-planner",
      })).resolves.toBe("task-session");

      expect(vi.mocked(fetch).mock.calls[0]).toEqual([
        "/api/tasks/task-1/session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ agent: "implementation-planner" }),
        }),
      ]);
    });
  });

  it("preserves explicit clears and leaves other updates unchanged", () => {
    // undefined values for model/reasoningEffort are serialized as empty strings to signal clear intent
    expect(serializeSettingsPatch({ model: undefined })).toBe(JSON.stringify({ model: "" }));
    expect(serializeSettingsPatch({ reasoningEffort: undefined })).toBe(JSON.stringify({ reasoningEffort: "" }));
    expect(serializeSettingsPatch({ theme: "dark", model: "gpt-5.4", reasoningEffort: "high" })).toBe(
      JSON.stringify({ theme: "dark", model: "gpt-5.4", reasoningEffort: "high" }),
    );
  });
});

describe("docs DB entry client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubJsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? "OK",
      json: async () => body,
    })));
  }

  it("updateDbEntryPage PATCHes the DB entry route with the editor content", async () => {
    stubJsonResponse({ path: "incidents/march-outage", success: true });

    await expect(updateDbEntryPage("incidents/march-outage", { content: "---\ntitle: X\n---\n\nbody" }))
      .resolves.toEqual({ path: "incidents/march-outage", success: true });

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/docs/db/incidents/march-outage",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "---\ntitle: X\n---\n\nbody" }),
      },
    );
  });

  it("updateDbEntryPage throws the server error message on failure", async () => {
    stubJsonResponse({ error: "Invalid frontmatter: bad" }, { ok: false, status: 400 });

    await expect(updateDbEntryPage("incidents/x", { content: "bad" }))
      .rejects.toThrow("Invalid frontmatter: bad");
  });

  it("deleteDbEntryPage DELETEs the DB entry route", async () => {
    stubJsonResponse({ path: "incidents/march-outage", deleted: true });

    await expect(deleteDbEntryPage("incidents/march-outage"))
      .resolves.toEqual({ path: "incidents/march-outage", deleted: true });

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/docs/db/incidents/march-outage",
      { method: "DELETE" },
    );
  });

  it("deleteDbEntryPage throws the server error message on failure", async () => {
    stubJsonResponse({ error: "No database collection found at \"incidents\"" }, { ok: false, status: 400 });

    await expect(deleteDbEntryPage("incidents/x"))
      .rejects.toThrow('No database collection found at "incidents"');
  });
});
