import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestApp, createMockSessionManager } from "./helpers.js";

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
    mkdirSync(join(copilotHome, "session-state", "session-1"), { recursive: true });
    writeFileSync(join(copilotHome, "session-state", "session-1", "workspace.yaml"), "cwd: /legacy/workspace\n");
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Workspace task");
    ctx.taskStore.updateTask(task.id, { cwd: "/task/workspace" });
    ctx.taskStore.linkSession(task.id, "session-1");
    ctx.sessionWorkspaceStore.setWorkspace("session-1", "/override/workspace");

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        workspace: expect.objectContaining({
          effectiveCwd: "/override/workspace",
          taskCwd: "/task/workspace",
          sessionOverride: expect.objectContaining({ cwd: "/override/workspace" }),
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
    expect(firstRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "idle", busy: false });
    expect(secondRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "busy", busy: true });
    expect(thirdRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "idle", busy: false });
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
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

  it("returns workspace warnings and task-derived sibling worktrees", async () => {
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
    ctx.sessionWorkspaceStore.setWorkspace("session-1", "/missing/workspace");

    const res = await request(app).get(`/api/sessions/session-1/workspace?taskId=${task.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sessionId: "session-1",
      taskId: task.id,
      source: "session_workspace",
      pathState: "missing",
      warnings: [{
        code: "missing_pinned_workspace",
        message: "Pinned session workspace does not exist: /missing/workspace",
      }],
      gitStatus: {
        status: "unavailable",
        cwd: "/missing/workspace",
        error: "Pinned session workspace does not exist: /missing/workspace",
      },
      availableWorktrees: [
        expect.objectContaining({ cwd: taskWorkspace, selected: false }),
        expect.objectContaining({ cwd: join(copilotHome, "task-workspace-feature"), selected: false }),
      ],
    }));
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

  it("builds workspace details from the legacy flat git status shape", async () => {
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
      branch: "main",
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
    });
    const testApp = createTestApp({ copilotHome, sessionManager });
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
      gitStatus: expect.objectContaining({
        status: "ok",
        cwd: taskWorkspace,
        repoName: "copilot-bridge",
        branch: "main",
      }),
      availableWorktrees: [
        expect.objectContaining({
          cwd: taskWorkspace,
          workspaceKind: "main",
          head: { kind: "branch", name: "main" },
          selected: true,
        }),
      ],
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

  it("resets a session workspace back to the linked task cwd without falling back to legacy yaml", async () => {
    const copilotHome = createCopilotHome();
    mkdirSync(join(copilotHome, "session-state", "session-1"), { recursive: true });
    writeFileSync(join(copilotHome, "session-state", "session-1", "workspace.yaml"), "cwd: /legacy/workspace\n");
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: async () => [{ sessionId: "session-1", summary: "Workspace session" }],
    } as any;
    readGitWorktreeStatusMock.mockResolvedValue({
      status: "not_repo",
      cwd: "/task/workspace",
    });
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    const task = ctx.taskStore.createTask("Workspace task");
    ctx.taskStore.updateTask(task.id, { cwd: "/task/workspace" });
    ctx.taskStore.linkSession(task.id, "session-1");
    const otherTask = ctx.taskStore.createTask("Other workspace task");
    ctx.taskStore.updateTask(otherTask.id, { cwd: "/other/workspace" });
    ctx.taskStore.linkSession(otherTask.id, "session-1");
    ctx.sessionWorkspaceStore.setWorkspace("session-1", "/override/workspace");
    const resetSessionWorkspace = vi.fn((sessionId: string, opts?: { taskCwd?: string }) => {
      ctx.sessionWorkspaceStore.setWorkspace(sessionId, opts?.taskCwd ?? "/task/workspace");
      return {
        cwd: opts?.taskCwd ?? "/task/workspace",
        source: "task-default",
        message: `Session workspace reset to linked task default ${opts?.taskCwd ?? "/task/workspace"}`,
      };
    });
    ctx.sessionManager.resetSessionWorkspace = resetSessionWorkspace as any;

    const res = await request(app).delete(`/api/sessions/session-1/workspace?taskId=${task.id}`);

    expect(res.status).toBe(200);
    expect(resetSessionWorkspace).toHaveBeenCalledWith("session-1", {
      taskId: task.id,
      taskCwd: "/task/workspace",
    });
    expect(ctx.sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({
      cwd: "/task/workspace",
    });
    expect(res.body).toEqual(expect.objectContaining({
      effectiveCwd: "/task/workspace",
      taskCwd: "/task/workspace",
      overridesTaskWorkspace: false,
      source: "session_workspace",
      sessionOverride: expect.objectContaining({ cwd: "/task/workspace" }),
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
