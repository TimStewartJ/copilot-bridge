import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "./test-http.js";
import type { Express } from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockSessionManager } from "./helpers.js";
import { createTestApp } from "./test-app.js";

const readGitWorktreeStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../git-worktree-status.js", () => ({
  readGitWorktreeStatus: readGitWorktreeStatusMock,
}));

describe("session workspace routes", () => {
  let app: Express;
  let ctx: ReturnType<typeof createTestApp>["ctx"];
  const tempDirs: string[] = [];

  function createCopilotHome() {
    const dir = mkdtempSync(join(tmpdir(), "bridge-session-workspace-api-"));
    tempDirs.push(dir);
    return dir;
  }

  function createWorkspace(root: string, name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    readGitWorktreeStatusMock.mockReset();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extends the session list payload with effective workspace and override state", async () => {
    const copilotHome = createCopilotHome();
    const legacyWorkspace = createWorkspace(copilotHome, "legacy-workspace");
    const taskWorkspace = createWorkspace(copilotHome, "task-workspace");
    const overrideWorkspace = createWorkspace(copilotHome, "override-workspace");
    mkdirSync(join(copilotHome, "session-state", "session-1"), { recursive: true });
    writeFileSync(join(copilotHome, "session-state", "session-1", "workspace.yaml"), `cwd: ${legacyWorkspace}\n`);
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Workspace task");
    ctx.taskStore.updateTask(task.id, { cwd: taskWorkspace });
    ctx.taskStore.linkSession(task.id, "session-1");
    ctx.sessionWorkspaceStore.setWorkspace("session-1", overrideWorkspace);

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        workspace: expect.objectContaining({
          effectiveCwd: overrideWorkspace,
          taskCwd: taskWorkspace,
          sessionOverride: expect.objectContaining({ cwd: overrideWorkspace }),
          overridesTaskWorkspace: true,
        }),
      }),
    ]);
  });

  it("builds an active-only session list unless archived sessions are requested", async () => {
    const copilotHome = createCopilotHome();
    const listSessionsFromDisk = vi.fn(async (opts?: { includeArchived?: boolean }) => (
      opts?.includeArchived
        ? [
          { sessionId: "active-session", summary: "Active session" },
          { sessionId: "archived-session", summary: "Archived session" },
        ]
        : [{ sessionId: "active-session", summary: "Active session" }]
    ));
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("active-session", "Active session");
    ctx.sessionTitles.setTitle("archived-session", "Archived session");
    ctx.sessionMetaStore.setArchived("archived-session", true);

    const activeRes = await request(app).get("/api/sessions");
    const archivedRes = await request(app).get("/api/sessions?includeArchived=true");

    expect(activeRes.status).toBe(200);
    expect(activeRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["active-session"]);
    expect(archivedRes.status).toBe(200);
    expect(archivedRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["active-session", "archived-session"]);
    expect(listSessionsFromDisk).toHaveBeenNthCalledWith(1, { includeArchived: false });
    expect(listSessionsFromDisk).toHaveBeenNthCalledWith(2, { includeArchived: true });
  });

  it("does not coalesce active session list requests onto an in-flight archived build", async () => {
    const copilotHome = createCopilotHome();
    let resolveArchivedBuild: (sessions: any[]) => void = () => {};
    let markArchivedStarted: () => void = () => {};
    const archivedBuildStarted = new Promise<void>((resolve) => {
      markArchivedStarted = resolve;
    });
    const archivedSessions = new Promise<any[]>((resolve) => {
      resolveArchivedBuild = resolve;
    });
    const listSessionsFromDisk = vi.fn((opts?: { includeArchived?: boolean }) => {
      if (opts?.includeArchived) {
        markArchivedStarted();
        return archivedSessions;
      }
      return Promise.resolve([{ sessionId: "active-session", summary: "Active session" }]);
    });
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("active-session", "Active session");
    ctx.sessionTitles.setTitle("archived-session", "Archived session");
    ctx.sessionMetaStore.setArchived("archived-session", true);

    const archivedRequest = request(app).get("/api/sessions?includeArchived=true").then((res) => res);
    await archivedBuildStarted;
    const activeRes = await request(app).get("/api/sessions");
    resolveArchivedBuild([
      { sessionId: "active-session", summary: "Active session" },
      { sessionId: "archived-session", summary: "Archived session" },
    ]);
    const archivedRes = await archivedRequest;

    expect(activeRes.status).toBe(200);
    expect(activeRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["active-session"]);
    expect(archivedRes.status).toBe(200);
    expect(archivedRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["active-session", "archived-session"]);
    expect(listSessionsFromDisk).toHaveBeenNthCalledWith(1, { includeArchived: true });
    expect(listSessionsFromDisk).toHaveBeenNthCalledWith(2, { includeArchived: false });
  });

  it("reuses a completed archived cache for active lists while preserving active filtering", async () => {
    const copilotHome = createCopilotHome();
    const listSessionsFromDisk = vi.fn(async (opts?: { includeArchived?: boolean }) => (
      opts?.includeArchived
        ? [
          { sessionId: "active-session", summary: "Active session" },
          { sessionId: "archived-session", summary: "Archived session" },
        ]
        : [{ sessionId: "active-session", summary: "Active session" }]
    ));
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("active-session", "Active session");
    ctx.sessionTitles.setTitle("archived-session", "Archived session");
    ctx.sessionMetaStore.setArchived("archived-session", true);

    const archivedRes = await request(app).get("/api/sessions?includeArchived=true");
    const activeRes = await request(app).get("/api/sessions");

    expect(archivedRes.status).toBe(200);
    expect(archivedRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["active-session", "archived-session"]);
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["active-session"]);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an active cache for archived session list requests", async () => {
    const copilotHome = createCopilotHome();
    const listSessionsFromDisk = vi.fn(async (opts?: { includeArchived?: boolean }) => (
      opts?.includeArchived
        ? [
          { sessionId: "active-session", summary: "Active session" },
          { sessionId: "archived-session", summary: "Archived session" },
        ]
        : [{ sessionId: "active-session", summary: "Active session" }]
    ));
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("active-session", "Active session");
    ctx.sessionTitles.setTitle("archived-session", "Archived session");
    ctx.sessionMetaStore.setArchived("archived-session", true);

    const activeRes = await request(app).get("/api/sessions");
    const archivedRes = await request(app).get("/api/sessions?includeArchived=true");

    expect(activeRes.status).toBe(200);
    expect(activeRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["active-session"]);
    expect(archivedRes.status).toBe(200);
    expect(archivedRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["active-session", "archived-session"]);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(2);
  });

  it("keeps the session list cache across busy and idle events", async () => {
    const copilotHome = createCopilotHome();
    let runState = "idle";
    const listSessionsFromDisk = vi.fn(async () => [{ sessionId: "session-1", summary: "Cached session" }]);
    const sessionManager = {
      ...createMockSessionManager(),
      getSessionRunState: vi.fn(() => runState),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", "Cached session");

    const firstRes = await request(app).get("/api/sessions");
    runState = "busy";
    ctx.globalBus.emit({ type: "session:busy", sessionId: "session-1" });
    const secondRes = await request(app).get("/api/sessions");
    runState = "idle";
    ctx.globalBus.emit({ type: "session:idle", sessionId: "session-1" });
    const thirdRes = await request(app).get("/api/sessions");

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(thirdRes.status).toBe(200);
    expect(firstRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "idle" });
    expect(secondRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "busy" });
    expect(thirdRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "idle" });
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });

  it("serves a TTL-expired session list immediately and refreshes it in the background", async () => {
    const copilotHome = createCopilotHome();
    let summary = "Original title";
    let releaseBuild: () => void = () => {};
    const listSessionsFromDisk = vi.fn(async () => {
      if (listSessionsFromDisk.mock.calls.length > 1) {
        await new Promise<void>((resolve) => { releaseBuild = resolve; });
      }
      return [{ sessionId: "session-1", summary }];
    });
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", summary);
    const realNow = Date.now;
    let offsetMs = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);

    try {
      const firstRes = await request(app).get("/api/sessions");
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.sessions[0]).toMatchObject({ summary: "Original title" });
      expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);

      summary = "Refreshed title";
      offsetMs = 31_000;
      const staleStart = realNow();
      const staleRes = await request(app).get("/api/sessions");
      const staleElapsed = realNow() - staleStart;
      // The stale payload is served without waiting on the blocked rebuild, which
      // starts only after the response has been written.
      expect(staleRes.status).toBe(200);
      expect(staleRes.body.sessions[0]).toMatchObject({ summary: "Original title" });
      expect(staleElapsed).toBeLessThan(5_000);
      await vi.waitFor(() => expect(listSessionsFromDisk).toHaveBeenCalledTimes(2));

      // A second stale poll coalesces onto the running refresh instead of starting another.
      const staleAgainRes = await request(app).get("/api/sessions");
      expect(staleAgainRes.body.sessions[0]).toMatchObject({ summary: "Original title" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(listSessionsFromDisk).toHaveBeenCalledTimes(2);

      releaseBuild();
      await vi.waitFor(async () => {
        const res = await request(app).get("/api/sessions");
        expect(res.body.sessions[0]).toMatchObject({ summary: "Refreshed title" });
      });
      expect(listSessionsFromDisk).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("collapses concurrent stale polls onto one background refresh", async () => {
    const copilotHome = createCopilotHome();
    const listSessionsFromDisk = vi.fn(async () => [{ sessionId: "session-1", summary: "Cached session" }]);
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", "Cached session");
    const realNow = Date.now;
    let offsetMs = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);

    try {
      await request(app).get("/api/sessions");
      offsetMs = 31_000;
      const responses = await Promise.all([
        request(app).get("/api/sessions"),
        request(app).get("/api/sessions"),
        request(app).get("/api/sessions"),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.sessions.map((s: any) => s.sessionId)).toEqual(["session-1"]);
      }
      await vi.waitFor(() => expect(listSessionsFromDisk).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(listSessionsFromDisk).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rebuilds synchronously after a structural invalidation even when a TTL-expired cache exists", async () => {
    const copilotHome = createCopilotHome();
    let summary = "Original title";
    const listSessionsFromDisk = vi.fn(async () => [{ sessionId: "session-1", summary }]);
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", summary);
    const realNow = Date.now;
    let offsetMs = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);

    try {
      await request(app).get("/api/sessions");
      summary = "Renamed title";
      offsetMs = 31_000;
      ctx.globalBus.emit({ type: "session:title", sessionId: "session-1", title: summary });
      const res = await request(app).get("/api/sessions");

      expect(res.status).toBe(200);
      expect(res.body.sessions[0]).toMatchObject({ summary: "Renamed title" });
      expect(listSessionsFromDisk).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("resolves linked tasks for the session list from one task listing instead of per-session queries", async () => {
    const copilotHome = createCopilotHome();
    const sessions = Array.from({ length: 40 }, (_, index) => ({
      sessionId: `session-${index}`,
      summary: `Session ${index}`,
    }));
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: vi.fn(async () => sessions),
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Linked task");
    ctx.taskStore.linkSession(task.id, "session-5");
    const findTaskBySessionIdSpy = vi.spyOn(ctx.taskStore, "findTaskBySessionId");

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    const bySessionId = new Map(res.body.sessions.map((s: any) => [s.sessionId, s]));
    expect(bySessionId.get("session-5")).toMatchObject({ linkedTaskIds: [task.id] });
    expect(bySessionId.get("session-6")).toMatchObject({ linkedTaskIds: [] });
    expect(findTaskBySessionIdSpy).not.toHaveBeenCalled();
  });

  it("keeps in-flight session list builds cacheable when run-state events arrive", async () => {
    const copilotHome = createCopilotHome();
    let resolveSessions: (sessions: any[]) => void = () => {};
    let markStarted: () => void = () => {};
    const sessionsReady = new Promise<any[]>((resolve) => {
      resolveSessions = resolve;
    });
    const buildStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const listSessionsFromDisk = vi.fn(() => {
      markStarted();
      return sessionsReady;
    });
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", "Cached session");

    const firstRequest = request(app).get("/api/sessions").then((res) => res);
    await buildStarted;
    ctx.globalBus.emit({ type: "session:busy", sessionId: "session-1" });
    resolveSessions([{ sessionId: "session-1", summary: "Cached session" }]);
    const firstRes = await firstRequest;
    const secondRes = await request(app).get("/api/sessions");

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.sessions.map((s: any) => s.sessionId)).toEqual(["session-1"]);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });

  it("debounces bursty non-visibility session list invalidations", async () => {
    const copilotHome = createCopilotHome();
    const listSessionsFromDisk = vi.fn(async () => [{ sessionId: "session-1", summary: "Cached session" }]);
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", "Cached session");

    await request(app).get("/api/sessions");
    ctx.globalBus.emit({ type: "session:title", sessionId: "session-1" });
    ctx.globalBus.emit({ type: "task:changed" });
    ctx.globalBus.emit({ type: "schedule:changed" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(2);
  });

  it("flushes pending debounced invalidations before serving a session list", async () => {
    const copilotHome = createCopilotHome();
    const listSessionsFromDisk = vi.fn(async () => [{ sessionId: "session-1", summary: "Cached session" }]);
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", "Cached session");

    await request(app).get("/api/sessions");
    ctx.globalBus.emit({ type: "session:title", sessionId: "session-1" });
    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(2);
  });

  it("keeps archive invalidation immediate when a debounced invalidation is pending", async () => {
    const copilotHome = createCopilotHome();
    const listSessionsFromDisk = vi.fn(async () => [{ sessionId: "session-1", summary: "Cached session" }]);
    const sessionManager = {
      ...createMockSessionManager(),
      invalidateSessionListCache: vi.fn(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", "Cached session");

    await request(app).get("/api/sessions");
    ctx.globalBus.emit({ type: "session:title", sessionId: "session-1" });
    ctx.sessionMetaStore.setArchived("session-1", true);
    ctx.globalBus.emit({ type: "session:archived", sessionId: "session-1", archived: true });
    const archivedRes = await request(app).get("/api/sessions");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cachedArchivedRes = await request(app).get("/api/sessions");

    expect(archivedRes.status).toBe(200);
    expect(cachedArchivedRes.status).toBe(200);
    expect(archivedRes.body.sessions).toEqual([]);
    expect(cachedArchivedRes.body.sessions).toEqual([]);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(2);
    expect(sessionManager.invalidateSessionListCache).toHaveBeenCalledTimes(1);
  });

  it("avoids arbitrary task workspace defaults in the session list for multi-task sessions", async () => {
    const copilotHome = createCopilotHome();
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const taskA = ctx.taskStore.createTask("Task A");
    ctx.taskStore.updateTask(taskA.id, { cwd: "/task/a" });
    ctx.taskStore.linkSession(taskA.id, "session-1");
    const taskB = ctx.taskStore.createTask("Task B");
    ctx.taskStore.updateTask(taskB.id, { cwd: "/task/b" });
    ctx.taskStore.linkSession(taskB.id, "session-1");

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        workspace: expect.objectContaining({
          overridesTaskWorkspace: false,
        }),
      }),
    ]);
    expect(res.body.sessions[0].workspace.effectiveCwd).toBeUndefined();
    expect(res.body.sessions[0].workspace.taskCwd).toBeUndefined();
  });

  it("falls back to task workspace when the pinned session workspace is missing", async () => {
    const copilotHome = createCopilotHome();
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    const taskWorkspace = join(copilotHome, "task-workspace");
    mkdirSync(taskWorkspace, { recursive: true });
    readGitWorktreeStatusMock.mockResolvedValue({
      status: "ok",
      cwd: taskWorkspace,
      repoRoot: taskWorkspace,
      repoName: "copilot-bridge",
      worktreePath: taskWorkspace,
      workspaceKind: "main",
      head: { kind: "branch", name: "main" },
      dirty: {
        clean: true,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
      siblingWorktrees: [{
        worktreePath: join(copilotHome, "task-workspace-feature"),
        workspaceKind: "linked",
        head: { kind: "branch", name: "feature/workspace" },
      }],
      branch: "main",
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    });
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Workspace task");
    ctx.taskStore.updateTask(task.id, { cwd: taskWorkspace });
    ctx.taskStore.linkSession(task.id, "session-1");
    const missingWorkspace = join(copilotHome, "missing-workspace");
    ctx.sessionWorkspaceStore.setWorkspace("session-1", missingWorkspace);

    const res = await request(app).get(`/api/sessions/session-1/workspace?taskId=${task.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sessionId: "session-1",
      taskId: task.id,
      effectiveCwd: taskWorkspace,
      source: "task",
      pathState: "available",
      warnings: [
        expect.objectContaining({
          code: "cleared_pinned_workspace",
          message: expect.stringContaining(missingWorkspace),
        }),
      ],
      gitStatus: expect.objectContaining({
        status: "ok",
        cwd: taskWorkspace,
      }),
      availableWorktrees: [
        expect.objectContaining({ cwd: taskWorkspace, selected: true }),
        expect.objectContaining({ cwd: join(copilotHome, "task-workspace-feature"), selected: false }),
      ],
    }));
    expect(res.body.sessionOverride).toBeUndefined();
    expect(ctx.sessionWorkspaceStore.getWorkspace("session-1")).toBeUndefined();
    expect(readGitWorktreeStatusMock).toHaveBeenCalledWith(taskWorkspace);
  });

  it("falls back to linked task workspace when the session workspace store is unavailable", async () => {
    const copilotHome = createCopilotHome();
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    const taskWorkspace = join(copilotHome, "task-workspace");
    mkdirSync(taskWorkspace, { recursive: true });
    readGitWorktreeStatusMock.mockResolvedValue({
      status: "not_repo",
      cwd: taskWorkspace,
    });
    const testApp = createTestApp({
      copilotHome,
      sessionManager,
      sessionWorkspaceStore: undefined as any,
    });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Workspace task");
    ctx.taskStore.updateTask(task.id, { cwd: taskWorkspace });
    ctx.taskStore.linkSession(task.id, "session-1");

    const res = await request(app).get(`/api/sessions/session-1/workspace?taskId=${task.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sessionId: "session-1",
      taskId: task.id,
      effectiveCwd: taskWorkspace,
      taskCwd: taskWorkspace,
      source: "task",
      overridesTaskWorkspace: false,
      pathState: "available",
      warnings: [],
      gitStatus: {
        status: "not_repo",
        cwd: taskWorkspace,
      },
    }));
  });

  it("stores an explicit workspace path", async () => {
    const copilotHome = createCopilotHome();
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    const explicitWorkspace = join(copilotHome, "explicit-workspace");
    mkdirSync(explicitWorkspace, { recursive: true });
    readGitWorktreeStatusMock.mockResolvedValue({
      status: "not_repo",
      cwd: explicitWorkspace,
    });
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const setSessionWorkspace = vi.fn((sessionId: string, cwd: string) => {
      ctx.sessionWorkspaceStore.setWorkspace(sessionId, cwd);
      return {
        cwd,
        source: "explicit",
        message: `Session workspace set to ${cwd} for future turns`,
      };
    });
    ctx.sessionManager.setSessionWorkspace = setSessionWorkspace as any;

    const res = await request(app)
      .put("/api/sessions/session-1/workspace/path")
      .send({ cwd: explicitWorkspace });

    expect(res.status).toBe(200);
    expect(setSessionWorkspace).toHaveBeenCalledWith("session-1", explicitWorkspace);
    expect(ctx.sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({
      cwd: explicitWorkspace,
    });
  });

  it("blocks workspace changes while the session is busy", async () => {
    const copilotHome = createCopilotHome();
    const sessionManager = {
      ...createMockSessionManager(),
      isSessionBusy: () => true,
      getSessionRunState: () => "busy",
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;

    const res = await request(app)
      .put("/api/sessions/session-1/workspace/path")
      .send({ cwd: "/workspace/blocked" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Cannot change workspace for a busy session." });
  });

  it("accepts only discovered sibling worktrees", async () => {
    const copilotHome = createCopilotHome();
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    const taskWorkspace = join(copilotHome, "task-workspace");
    mkdirSync(taskWorkspace, { recursive: true });
    const siblingWorkspace = join(copilotHome, "task-workspace-feature");
    mkdirSync(siblingWorkspace, { recursive: true });
    readGitWorktreeStatusMock.mockResolvedValue({
      status: "ok",
      cwd: taskWorkspace,
      repoRoot: taskWorkspace,
      repoName: "copilot-bridge",
      worktreePath: taskWorkspace,
      workspaceKind: "main",
      head: { kind: "branch", name: "main" },
      dirty: {
        clean: true,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
      siblingWorktrees: [{
        worktreePath: siblingWorkspace,
        workspaceKind: "linked",
        head: { kind: "branch", name: "feature/workspace" },
      }],
      branch: "main",
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    });
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Workspace task");
    ctx.taskStore.updateTask(task.id, { cwd: taskWorkspace });
    ctx.taskStore.linkSession(task.id, "session-1");
    const setSessionWorkspace = vi.fn((sessionId: string, cwd: string) => {
      ctx.sessionWorkspaceStore.setWorkspace(sessionId, cwd);
      return {
        cwd,
        source: "explicit",
        message: `Session workspace set to ${cwd} for future turns`,
      };
    });
    ctx.sessionManager.setSessionWorkspace = setSessionWorkspace as any;

    const invalid = await request(app)
      .put(`/api/sessions/session-1/workspace/worktree?taskId=${task.id}`)
      .send({ cwd: join(copilotHome, "task-workspace-other") });
    const valid = await request(app)
      .put(`/api/sessions/session-1/workspace/worktree?taskId=${task.id}`)
      .send({ cwd: siblingWorkspace });

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: "Selected workspace is not a discovered sibling worktree." });
    expect(valid.status).toBe(200);
    expect(setSessionWorkspace).toHaveBeenCalledWith("session-1", siblingWorkspace);
    expect(ctx.sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({
      cwd: siblingWorkspace,
    });
  });

  it("resets a session workspace back to the linked task cwd without falling back to the recorded workspace.yaml cwd", async () => {
    const copilotHome = createCopilotHome();
    const legacyWorkspace = createWorkspace(copilotHome, "legacy-workspace");
    const taskWorkspace = createWorkspace(copilotHome, "task-workspace");
    const otherWorkspace = createWorkspace(copilotHome, "other-workspace");
    const overrideWorkspace = createWorkspace(copilotHome, "override-workspace");
    mkdirSync(join(copilotHome, "session-state", "session-1"), { recursive: true });
    writeFileSync(join(copilotHome, "session-state", "session-1", "workspace.yaml"), `cwd: ${legacyWorkspace}\n`);
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    readGitWorktreeStatusMock.mockResolvedValue({
      status: "not_repo",
      cwd: taskWorkspace,
    });
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Workspace task");
    ctx.taskStore.updateTask(task.id, { cwd: taskWorkspace });
    ctx.taskStore.linkSession(task.id, "session-1");
    const otherTask = ctx.taskStore.createTask("Other workspace task");
    ctx.taskStore.updateTask(otherTask.id, { cwd: otherWorkspace });
    ctx.taskStore.linkSession(otherTask.id, "session-1");
    ctx.sessionWorkspaceStore.setWorkspace("session-1", overrideWorkspace);
    const resetSessionWorkspace = vi.fn((sessionId: string, opts?: { taskCwd?: string }) => {
      ctx.sessionWorkspaceStore.setWorkspace(sessionId, opts?.taskCwd ?? taskWorkspace);
      return {
        cwd: opts?.taskCwd ?? taskWorkspace,
        source: "task-default",
        message: `Session workspace reset to linked task default ${opts?.taskCwd ?? taskWorkspace}`,
      };
    });
    ctx.sessionManager.resetSessionWorkspace = resetSessionWorkspace as any;

    const res = await request(app).delete(`/api/sessions/session-1/workspace?taskId=${task.id}`);

    expect(res.status).toBe(200);
    expect(resetSessionWorkspace).toHaveBeenCalledWith("session-1", {
      taskId: task.id,
      taskCwd: taskWorkspace,
    });
    expect(ctx.sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({
      cwd: taskWorkspace,
    });
    expect(res.body).toEqual(expect.objectContaining({
      effectiveCwd: taskWorkspace,
      taskCwd: taskWorkspace,
      overridesTaskWorkspace: false,
      source: "session_workspace",
      sessionOverride: expect.objectContaining({ cwd: taskWorkspace }),
    }));
  });

  it("requires taskId to reset a multi-task session workspace", async () => {
    const copilotHome = createCopilotHome();
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Workspace task");
    ctx.taskStore.linkSession(task.id, "session-1");
    const otherTask = ctx.taskStore.createTask("Other workspace task");
    ctx.taskStore.updateTask(otherTask.id, { cwd: "/other/workspace" });
    ctx.taskStore.linkSession(otherTask.id, "session-1");
    const resetSessionWorkspace = vi.fn(() => {
      throw new Error("Session is linked to multiple tasks; provide taskId when resetting workspace");
    });
    ctx.sessionManager.resetSessionWorkspace = resetSessionWorkspace as any;

    const res = await request(app).delete("/api/sessions/session-1/workspace");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Session is linked to multiple tasks; provide taskId when resetting workspace",
    });
    expect(resetSessionWorkspace).toHaveBeenCalledWith("session-1");
  });
});
