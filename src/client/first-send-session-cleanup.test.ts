import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Task } from "./api";
import {
  cleanupFailedFirstSendSession,
  sendMaterializedFirstPrompt,
} from "./first-send-session-cleanup";
import { queryKeys } from "./queryClient";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createSession(sessionId: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId,
    summary: sessionId,
    modifiedTime: "2026-05-21T12:00:00.000Z",
    runState: "idle",
    busy: false,
    deferSummary: { count: 0, nextRunAt: null },
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task 1",
    kind: "task",
    muted: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-05-21T12:00:00.000Z",
    updatedAt: "2026-05-21T12:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("first-send session cleanup", () => {
  it("deletes and removes optimistic session state when the first send rejects", async () => {
    const queryClient = createQueryClient();
    const newSession = createSession("session-new", { isOptimistic: true });
    queryClient.setQueryData<Session[]>(
      queryKeys.sessions({ includeArchived: false }),
      [newSession, createSession("session-existing")],
    );
    queryClient.setQueryData<Session[]>(
      queryKeys.sessions({ includeArchived: true }),
      [newSession, createSession("session-archived", { archived: true })],
    );
    queryClient.setQueryData<Task[]>(
      queryKeys.tasks,
      [createTask({ sessionIds: ["session-existing", "session-new"] })],
    );
    let selectedTask: Task | null = createTask({ sessionIds: ["session-new"] });
    const sendError = new Error("send failed");
    const sendChatMessage = vi.fn(async () => {
      throw sendError;
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const clearPendingPromptSession = vi.fn();
    const clearDraft = vi.fn();
    const clearDraftSessionBySessionId = vi.fn();
    const clearLastViewedSession = vi.fn();
    const clearLastActiveQuickChat = vi.fn();
    const invalidateAllSessionQueries = vi.fn(async () => {});
    const invalidateTasks = vi.fn(async () => {});

    await expect(sendMaterializedFirstPrompt({
      sessionId: "session-new",
      prompt: "hello",
      sendChatMessage,
      onRejected: () => cleanupFailedFirstSendSession({
        sessionId: "session-new",
        taskId: "task-1",
        queryClient,
        clearPendingPromptSession,
        clearDraft,
        clearDraftSessionBySessionId,
        clearLastViewedSession,
        clearLastActiveQuickChat,
        updateSelectedTask: (updater) => {
          selectedTask = updater(selectedTask);
        },
        invalidateAllSessionQueries,
        invalidateTasks,
      }),
    })).rejects.toBe(sendError);

    expect(sendChatMessage).toHaveBeenCalledWith("session-new", "hello", undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-new", { method: "DELETE" });
    expect(clearPendingPromptSession).toHaveBeenCalledWith("session-new");
    expect(clearDraft).toHaveBeenCalledWith("session-new");
    expect(clearDraftSessionBySessionId).toHaveBeenCalledWith("session-new");
    expect(clearLastViewedSession).toHaveBeenCalledWith("session-new");
    expect(clearLastActiveQuickChat).toHaveBeenCalledWith("session-new");

    const sessionQueries = queryClient.getQueriesData<Session[]>({ queryKey: ["sessions"] });
    expect(sessionQueries.length).toBeGreaterThan(0);
    for (const [, sessions] of sessionQueries) {
      expect(sessions?.some((session) => session.sessionId === "session-new")).toBe(false);
    }
    expect(queryClient.getQueryData<Task[]>(queryKeys.tasks)?.[0]?.sessionIds)
      .toEqual(["session-existing"]);
    expect(selectedTask?.sessionIds).toEqual([]);
    expect(invalidateAllSessionQueries).toHaveBeenCalledTimes(1);
    expect(invalidateTasks).toHaveBeenCalledTimes(1);
  });

  it("keeps the original send error visible when delete cleanup fails", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<Session[]>(
      queryKeys.sessions({ includeArchived: false }),
      [createSession("session-new", { isOptimistic: true })],
    );
    const sendError = new Error("send failed");
    const deleteError = new Error("delete failed");
    const logger = { error: vi.fn() };

    await expect(sendMaterializedFirstPrompt({
      sessionId: "session-new",
      prompt: "hello",
      sendChatMessage: vi.fn(async () => {
        throw sendError;
      }),
      onRejected: () => cleanupFailedFirstSendSession({
        sessionId: "session-new",
        queryClient,
        clearPendingPromptSession: vi.fn(),
        deleteSession: vi.fn(async () => {
          throw deleteError;
        }),
        invalidateAllSessionQueries: vi.fn(async () => {}),
        logger,
      }),
    })).rejects.toBe(sendError);

    expect(logger.error).toHaveBeenCalledWith("Failed to clean up unsent session:", deleteError);
    expect(queryClient.getQueryData<Session[]>(queryKeys.sessions({ includeArchived: false })))
      .toEqual([]);
  });
});
