import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import type { Session, TaskArchivedSessionsResponse } from "../../api";
import type { StatusEvent } from "../../useStatusStream";
import { queryKeys } from "../../queryClient";
import { helmStateQueryKey } from "../../helm/helm-api";
import { emptyBackgroundAgentsSummary } from "../../../shared/session-agents.js";
import { TASK_OVERVIEW_KEY } from "./useTaskOverview";
import { projectSessionEvent, projectVoiceSessionActivity, type SessionEventEffects } from "./session-events";

const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });

function fixture() {
  const queryClient = new QueryClient();
  clients.push(queryClient);
  const sessions: Session[] = ["one", "two"].map((sessionId) => ({
    sessionId,
    summary: sessionId,
    runState: "idle",
    modifiedTime: "2026-10-16T17:00:00.000Z",
    deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
  }));
  const activeKey = queryKeys.sessions({ includeArchived: false });
  const allKey = queryKeys.sessions({ includeArchived: true });
  const pagesKey = queryKeys.taskArchivedSessions("task");
  queryClient.setQueryData(activeKey, sessions);
  queryClient.setQueryData(allKey, sessions);
  queryClient.setQueryData<InfiniteData<TaskArchivedSessionsResponse>>(pagesKey, {
    pages: [{ sessions, offset: 0, total: 2 }],
    pageParams: [0],
  });
  const effects = {
    queries: { invalidateQueries: vi.fn(async () => undefined) },
    isHelmSession: vi.fn(() => false),
    onBusy: vi.fn(),
    onIdle: vi.fn(),
    onArchived: vi.fn(),
    onHistoryTruncated: vi.fn(),
  } satisfies SessionEventEffects;
  return {
    queryClient, effects, activeKey, allKey, pagesKey,
    project: (event: StatusEvent) => projectSessionEvent(queryClient, event, effects),
  };
}

describe("session event projection", () => {
  it.each([
    [{ runState: "busy", intentText: "Checking results" }, "Checking results", "busy"],
    [{ runState: "busy", intentText: "Uploading voice input" }, "Sending voice message", "busy"],
    [{ runState: "idle", intentText: "Old intent" }, "Sending voice message", "busy"],
    [{ runState: "stalled", intentText: "Checking results" }, "Checking results", "stalled"],
  ] satisfies [Partial<Session>, string, Session["runState"]][])(
    "preserves voice activity intent and stalled-state rules: %j",
    (initial, intentText, runState) => {
      const { queryClient, activeKey, allKey, pagesKey } = fixture();
      for (const key of [activeKey, allKey]) {
        queryClient.setQueryData<Session[]>(key, (rows) => rows?.map((row) => ({ ...row, ...initial })));
      }
      projectVoiceSessionActivity(queryClient, { sessionId: "one", status: "sending" });
      expect(queryClient.getQueryData<Session[]>(activeKey)?.[0]).toMatchObject({ intentText, runState });
      expect(queryClient.getQueryData<Session[]>(allKey)?.[0]).toMatchObject({ intentText, runState });
      expect(queryClient.getQueryData<InfiniteData<TaskArchivedSessionsResponse>>(pagesKey)?.pages[0].sessions[0])
        .toMatchObject({ intentText: "Sending voice message", runState: "busy" });
    },
  );

  it("protects projected voice activity from an older list response", async () => {
    const { queryClient, activeKey } = fixture();
    let resolve!: (rows: Session[]) => void;
    const pending = queryClient.fetchQuery({
      queryKey: activeKey,
      queryFn: () => new Promise<Session[]>((done) => { resolve = done; }),
    });
    const original = queryClient.getQueryData<Session[]>(activeKey) ?? [];
    projectVoiceSessionActivity(queryClient, { sessionId: "one", status: "uploading" });
    resolve(original);
    await pending;
    expect(queryClient.getQueryData<Session[]>(activeKey)?.[0]).toMatchObject({
      runState: "busy", intentText: "Uploading voice input",
    });
  });

  it.each([
    [{ type: "session:busy", sessionId: "one" }, { runState: "busy" }],
    [{ type: "session:stalled", sessionId: "one" }, { runState: "stalled" }],
    [{ type: "session:idle", sessionId: "one" }, { runState: "idle", intentText: null }],
    [{ type: "session:mode", sessionId: "one", agentMode: "autopilot" }, { agentMode: "autopilot" }],
    [{ type: "session:mode", sessionId: "one", agentMode: "interactive" }, { agentMode: null }],
    [{ type: "session:intent", sessionId: "one", intent: "Working" }, { intentText: "Working" }],
    [{ type: "session:intent", sessionId: "one" }, { intentText: null }],
    [{ type: "session:title", sessionId: "one", title: "Renamed" }, { summary: "Renamed" }],
    [{ type: "session:user-input", sessionId: "one", pendingUserInputCount: 2 },
      { pendingUserInputCount: 2, needsUserInput: true }],
    [{ type: "session:user-input", sessionId: "one" },
      { pendingUserInputCount: 0, needsUserInput: false }],
    [{ type: "session:agents", sessionId: "one", backgroundAgents: emptyBackgroundAgentsSummary() },
      { backgroundAgents: emptyBackgroundAgentsSummary() }],
  ] satisfies [StatusEvent, Partial<Session>][])("patches the same session in every cache: %j", (event, patch) => {
    const { queryClient, project, activeKey, allKey, pagesKey } = fixture();
    expect(project(event)).toBe(true);
    for (const key of [activeKey, allKey]) {
      expect(queryClient.getQueryData<Session[]>(key)?.[0]).toMatchObject(patch);
      expect(queryClient.getQueryData<Session[]>(key)?.[1]).toMatchObject({ sessionId: "two", runState: "idle" });
    }
    expect(queryClient.getQueryData<InfiniteData<TaskArchivedSessionsResponse>>(pagesKey)?.pages[0].sessions[0])
      .toMatchObject(patch);
  });

  it("refreshes visible activity on idle and signals busy/idle to the stream attachment owner", () => {
    const { project, effects, activeKey } = fixture();
    project({ type: "session:busy", sessionId: "one" });
    expect(effects.onBusy).toHaveBeenCalledExactlyOnceWith("one");
    expect(effects.queries.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.dashboard });
    effects.queries.invalidateQueries.mockClear();
    project({ type: "session:idle", sessionId: "one" });
    expect(effects.onIdle).toHaveBeenCalledExactlyOnceWith("one");
    expect(effects.queries.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: activeKey }], [{ queryKey: queryKeys.dashboard }],
    ]);
  });

  it.each(["session:title", "session:idle"] as const)("refreshes Helm when its conversation changes: %s", (type) => {
    const { project, effects } = fixture();
    effects.isHelmSession.mockReturnValue(true);
    project(type === "session:title"
      ? { type, sessionId: "one", title: "Renamed" }
      : { type, sessionId: "one" });
    expect(effects.queries.invalidateQueries).toHaveBeenCalledWith({ queryKey: helmStateQueryKey });
  });

  it("applies bulk archive changes once and refreshes all affected query families", () => {
    const { queryClient, project, effects, activeKey } = fixture();
    project({ type: "session:archived", sessionIds: ["one", "two"], archived: true });
    expect(queryClient.getQueryData<Session[]>(activeKey)?.every((session) => session.archived)).toBe(true);
    expect(effects.onArchived).toHaveBeenCalledExactlyOnceWith(["one", "two"], true);
    expect(effects.queries.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["sessions"] }],
      [{ queryKey: queryKeys.taskArchivedSessionsRoot }],
      [{ queryKey: queryKeys.tasks }],
    ]);
  });

  it.each([undefined, "one"])("limits ordinary list invalidations to the appropriate scope: %s", (sessionId) => {
    const { project, effects, activeKey } = fixture();
    project({ type: "sessions:changed", sessionId });
    expect(effects.queries.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: sessionId ? activeKey : ["sessions"] }],
      [{ queryKey: queryKeys.dashboard }],
    ]);
  });

  it("updates defer automation and history hints without inventing transcript state", () => {
    const { project, effects } = fixture();
    project({
      type: "session:defer-summary",
      sessionId: "one",
      deferSummary: { count: 1, runningCount: 0, nextRunAt: null },
    });
    expect(effects.queries.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: queryKeys.sessionDefers("one") }],
      [{ queryKey: TASK_OVERVIEW_KEY }],
    ]);
    effects.queries.invalidateQueries.mockClear();
    project({ type: "session:history-truncated", sessionId: "one" });
    expect(effects.onHistoryTruncated).toHaveBeenCalledExactlyOnceWith("one");
    expect(effects.queries.invalidateQueries).not.toHaveBeenCalled();
  });

  it("announces scheduled work through the same busy hint and refresh path", () => {
    const { project, effects, activeKey } = fixture();
    project({ type: "schedule:triggered", sessionId: "one", taskId: "task", scheduleId: "schedule" });
    expect(effects.onBusy).toHaveBeenCalledExactlyOnceWith("one");
    expect(effects.queries.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: activeKey }],
      [{ queryKey: queryKeys.tasks }],
      [{ queryKey: queryKeys.task("task") }],
      [{ queryKey: queryKeys.scheduleSessions("schedule") }],
    ]);
  });

  it("leaves other application events to their existing owners", () => {
    const { project, effects } = fixture();
    expect(project({ type: "status:connected" })).toBe(false);
    expect(project({ type: "task:changed", taskId: "task" })).toBe(false);
    expect(project({ type: "docs:changed", docPath: "note" })).toBe(false);
    expect(effects.queries.invalidateQueries).not.toHaveBeenCalled();
    expect(effects.onBusy).not.toHaveBeenCalled();
  });

  it("keeps a live event when an older fetch completes", async () => {
    const { queryClient, project, activeKey } = fixture();
    let resolve!: (sessions: Session[]) => void;
    const pending = queryClient.fetchQuery({
      queryKey: activeKey,
      queryFn: () => new Promise<Session[]>((innerResolve) => { resolve = innerResolve; }),
    });
    project({ type: "session:busy", sessionId: "one" });
    resolve([{
      sessionId: "one", summary: "Fresh title", runState: "idle",
      modifiedTime: "2026-10-16T17:00:00.000Z",
      deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
    }]);
    await pending;
    expect(queryClient.getQueryData<Session[]>(activeKey)?.[0]).toMatchObject({
      summary: "Fresh title", runState: "busy",
    });
  });
});
