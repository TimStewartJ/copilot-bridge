import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-support/api-routes.js";
import type { Express } from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockSessionManager } from "../server/__tests__/helpers.js";
import { createTestApp } from "../test-support/api-routes.js";

const readGitWorktreeStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../server/git-worktree-status.js", () => ({
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
    readGitWorktreeStatusMock.mockResolvedValue({ status: "not_repo", cwd: overrideWorkspace });
    const setSessionWorkspace = vi.fn((sessionId: string, cwd: string) => {
      ctx.sessionWorkspaceStore.setWorkspace(sessionId, cwd);
      return {
        cwd,
        source: "explicit",
        message: `Session workspace set to ${cwd} for future turns`,
      };
    });
    ctx.sessionManager.setSessionWorkspace = setSessionWorkspace as any;

    const set = await request(app)
      .put("/api/sessions/session-1/workspace/path")
      .send({ cwd: overrideWorkspace });

    expect(set.status).toBe(200);
    expect(setSessionWorkspace).toHaveBeenCalledWith("session-1", overrideWorkspace);
    expect(ctx.sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({
      cwd: overrideWorkspace,
    });

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
    const lastAttentionAt = "2026-04-16T12:00:00.000Z";
    ctx.sessionMetaStore.setLastAttentionAt("session-1", lastAttentionAt);
    ctx.globalBus.emit({ type: "sessions:changed", sessionId: "session-1", reason: "attention" });
    const thirdRes = await request(app).get("/api/sessions");

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(thirdRes.status).toBe(200);
    expect(firstRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "idle" });
    expect(secondRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "busy" });
    expect(thirdRes.body.sessions[0]).toMatchObject({ sessionId: "session-1", runState: "idle", lastAttentionAt });
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
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

  it("archiving removes a chat from the next list without a build, and restoring brings it back", async () => {
    const copilotHome = createCopilotHome();
    const listSessionsFromDisk = vi.fn(async (_options?: { includeArchived?: boolean }) => [{ sessionId: "session-1", summary: "Cached session" }]);
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const testApp = createTestApp({ copilotHome, sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;
    ctx.sessionTitles.setTitle("session-1", "Cached session");

    const before = await request(app).get("/api/sessions").expect(200);
    expect(before.body.sessions).toMatchObject([{ sessionId: "session-1", archivedAt: null }]);
    const archived = await request(app).patch("/api/sessions/session-1").send({ archived: true }).expect(200);
    expect(archived.body).toMatchObject({ ok: true, archived: true });
    const archivedRes = await request(app).get("/api/sessions").expect(200);
    const stillArchivedRes = await request(app).get("/api/sessions");

    expect(archivedRes.body.sessions).toEqual([]);
    expect(stillArchivedRes.body.sessions).toEqual([]);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);

    const history = await request(app).get("/api/sessions?includeArchived=true").expect(200);
    expect(history.body.sessions).toMatchObject([{ sessionId: "session-1", archived: true, archivedAt: expect.stringMatching(/^20/) }]);
    const restored = await request(app).patch("/api/sessions/session-1").send({ archived: false }).expect(200);
    expect(restored.body).toMatchObject({ ok: true, archived: false });
    const restoredRes = await request(app).get("/api/sessions");

    expect(restoredRes.body.sessions).toEqual([expect.objectContaining({ sessionId: "session-1", archived: false })]);
    expect(listSessionsFromDisk.mock.calls.filter(([options]) => !options?.includeArchived)).toHaveLength(2);
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
    // Neither task's folder is chosen; the session runs in the Bridge workspace.
    expect(res.body.sessions[0].workspace.effectiveCwd).toBe(ctx.runtimePaths!.workspaceDir);
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

  it("reports the Bridge workspace for a session that only recorded the server's own directory", async () => {
    const copilotHome = createCopilotHome();
    mkdirSync(join(copilotHome, "session-state", "session-1"), { recursive: true });
    writeFileSync(join(copilotHome, "session-state", "session-1", "workspace.yaml"), `cwd: ${process.cwd()}\n`);
    const testApp = createTestApp({ copilotHome, sessionManager: createMockSessionManager() as any });
    app = testApp.app;
    ctx = testApp.ctx;
    const workspaceDir = ctx.runtimePaths!.workspaceDir!;
    readGitWorktreeStatusMock.mockResolvedValue({ status: "not_repo", cwd: workspaceDir });

    const res = await request(app).get("/api/sessions/session-1/workspace");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      effectiveCwd: workspaceDir,
      source: "bridge_workspace",
      pathState: "available",
      canResetToTask: false,
    });
  });

  it("labels a pinned neutral workspace as the Bridge workspace and flags a task folder it overrides", async () => {
    const copilotHome = createCopilotHome();
    const taskWorkspace = createWorkspace(copilotHome, "task-workspace");
    const testApp = createTestApp({ copilotHome, sessionManager: createMockSessionManager() as any });
    app = testApp.app;
    ctx = testApp.ctx;
    const workspaceDir = ctx.runtimePaths!.workspaceDir!;
    readGitWorktreeStatusMock.mockResolvedValue({ status: "not_repo", cwd: workspaceDir });
    const task = ctx.taskStore.createTask("Later project");
    ctx.taskStore.updateTask(task.id, { cwd: taskWorkspace });
    ctx.taskStore.linkSession(task.id, "session-1");
    ctx.sessionWorkspaceStore.setWorkspace("session-1", workspaceDir);

    const res = await request(app).get("/api/sessions/session-1/workspace");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      effectiveCwd: workspaceDir,
      source: "bridge_workspace",
      taskCwd: taskWorkspace,
      overridesTaskWorkspace: true,
      canResetToTask: true,
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
