import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AppContext } from "../app-context.js";
import { SessionManager, createBridgeTools } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createGlobalBus } from "../global-bus.js";
import { createTaskStore } from "../task-store.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createSessionWorkspaceStore } from "../session-workspace-store.js";
import { openMemoryDatabase } from "../db.js";
import { createTaskGroupStore } from "../task-group-store.js";
import { createScheduleStore } from "../schedule-store.js";
import { createSettingsStore } from "../settings-store.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createReadStateStore } from "../read-state-store.js";
import { createChecklistStore } from "../checklist-store.js";
import { toolFailure } from "../tool-results.js";

describe("SessionManager workspace resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createManager(opts: {
    copilotHome?: string;
    runtimePaths?: any;
  } = {}) {
    const db = openMemoryDatabase();
    const globalBus = createGlobalBus();
    const taskStore = createTaskStore(db, globalBus, opts.runtimePaths ? { runtimePaths: opts.runtimePaths } : undefined);
    const sessionWorkspaceStore = createSessionWorkspaceStore(db);
    const manager = new SessionManager({
      tools: [],
      globalBus,
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      sessionWorkspaceStore,
      taskStore,
      config: { sessionMcpServers: {} },
      copilotHome: opts.copilotHome,
      runtimePaths: opts.runtimePaths,
    });

    return { manager: manager as any, taskStore, sessionWorkspaceStore };
  }

  function getTool(ctx: AppContext, name: string) {
    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} tool not found`);
    return tool;
  }

  function createInvocation(toolName: string, sessionId = "session-1") {
    return {
      sessionId,
      toolCallId: `tool-${toolName}`,
      toolName,
      arguments: {},
    };
  }

  function createToolContext() {
    const db = openMemoryDatabase();
    const globalBus = createGlobalBus();
    const eventBusRegistry = createEventBusRegistry();
    const taskStore = createTaskStore(db, globalBus);
    const sessionWorkspaceStore = createSessionWorkspaceStore(db);
    const sessionTitles = createSessionTitlesStore(db);
    const manager = new SessionManager({
      tools: [],
      globalBus,
      eventBusRegistry,
      sessionTitles,
      sessionWorkspaceStore,
      taskStore,
      taskGroupStore: createTaskGroupStore(db),
      scheduleStore: undefined as any,
      settingsStore: createSettingsStore(db),
      checklistStore: createChecklistStore(db, globalBus),
      config: { sessionMcpServers: {} },
    } as any) as any;
    const ctx = {
      taskStore,
      taskGroupStore: createTaskGroupStore(db),
      scheduleStore: createScheduleStore(db),
      settingsStore: createSettingsStore(db),
      sessionMetaStore: createSessionMetaStore(db),
      sessionWorkspaceStore,
      sessionTitles,
      readStateStore: createReadStateStore(db),
      checklistStore: createChecklistStore(db, globalBus),
      globalBus,
      eventBusRegistry,
      sessionManager: manager,
      transcriptionService: { getStatus: vi.fn(), transcribe: vi.fn() },
      voiceJobManager: {} as any,
    } as AppContext;
    manager.deps.taskGroupStore = ctx.taskGroupStore;
    manager.deps.settingsStore = ctx.settingsStore;
    manager.deps.checklistStore = ctx.checklistStore;
    return { ctx, manager, taskStore, sessionWorkspaceStore };
  }

  it("prefers persisted session workspace over legacy yaml and task cwd", () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const sessionDir = join(copilotHome, "session-state", "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), "cwd: /legacy/workspace\n");

    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Pinned task");
    taskStore.updateTask(task.id, { cwd: "/task/workspace" });
    taskStore.linkSession(task.id, "session-1");
    sessionWorkspaceStore.setWorkspace("session-1", "/persisted/workspace");

    const config = manager.buildSessionConfig({ sessionId: "session-1", task: taskStore.getTask(task.id) });
    expect(config.workingDirectory).toBe("/persisted/workspace");
  });

  it("falls back from legacy yaml to task cwd to demo workspace", () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const runtimePaths = {
      demoMode: true,
      workspaceDir: "/demo/workspace",
      dataDir: "/demo/data",
      docsDir: "/demo/docs",
      copilotHome,
      env: {},
    };
    const sessionDir = join(copilotHome, "session-state", "session-legacy");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), "cwd: /legacy/workspace\n");

    const { manager, taskStore } = createManager({ copilotHome, runtimePaths });
    const task = taskStore.createTask("Fallback task");
    taskStore.updateTask(task.id, { cwd: "/task/workspace" });

    expect(manager.buildSessionConfig({ sessionId: "session-legacy", task: taskStore.getTask(task.id) }).workingDirectory)
      .toBe("/legacy/workspace");
    expect(manager.buildSessionConfig({ task: taskStore.getTask(task.id) }).workingDirectory)
      .toBe("/task/workspace");
    expect(manager.buildSessionConfig().workingDirectory).toBe("/demo/workspace");
  });

  it("pins the task cwd for new task sessions", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Pinned task");
    taskStore.updateTask(task.id, { cwd: "/task/worktree" });

    manager.client = {
      createSession: vi.fn(async () => ({ sessionId: "task-session", disconnect: vi.fn() })),
    };

    await manager.createTaskSession(task.id, task.title, task.workItems, [], task.notes, task.cwd);

    expect(sessionWorkspaceStore.getWorkspace("task-session")).toMatchObject({ cwd: "/task/worktree" });
  });

  it("keeps existing task sessions pinned when the task default changes later", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Pinned task");
    taskStore.updateTask(task.id, { cwd: "/task/worktree-v1" });

    manager.client = {
      createSession: vi.fn(async () => ({ sessionId: "task-session", disconnect: vi.fn() })),
    };

    await manager.createTaskSession(task.id, task.title, task.workItems, [], task.notes, task.cwd);
    taskStore.updateTask(task.id, { cwd: "/task/worktree-v2" });

    expect(sessionWorkspaceStore.getWorkspace("task-session")).toMatchObject({ cwd: "/task/worktree-v1" });
    expect(manager.buildSessionConfig({
      sessionId: "task-session",
      task: taskStore.getTask(task.id),
    }).workingDirectory).toBe("/task/worktree-v1");
  });

  it("does not inject arbitrary task context when a session is linked to multiple tasks", () => {
    const { manager, taskStore } = createManager();
    const taskA = taskStore.createTask("Task A");
    taskStore.updateTask(taskA.id, { cwd: "/task/a", notes: "Notes A" });
    taskStore.linkSession(taskA.id, "session-1");
    const taskB = taskStore.createTask("Task B");
    taskStore.updateTask(taskB.id, { cwd: "/task/b", notes: "Notes B" });
    taskStore.linkSession(taskB.id, "session-1");

    const config = manager.buildSessionConfig({ sessionId: "session-1" });

    expect(config.workingDirectory).toBeUndefined();
    expect(config.systemMessage.content).not.toContain('You are helping with task "Task A"');
    expect(config.systemMessage.content).not.toContain('You are helping with task "Task B"');
    expect(config.systemMessage.content).not.toContain("Task notes:\nNotes A");
    expect(config.systemMessage.content).not.toContain("Task notes:\nNotes B");
  });

  it("copies legacy workspace state when duplicating a session", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const sourceDir = join(copilotHome, "session-state", "source-session");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "workspace.yaml"), "cwd: /legacy/source\n");

    const { manager, sessionWorkspaceStore } = createManager({ copilotHome });
    manager.client = {
      createSession: vi.fn(async () => {
        const sessionId = "duplicate-session";
        mkdirSync(join(copilotHome, "session-state", sessionId), { recursive: true });
        return { sessionId, disconnect: vi.fn() };
      }),
    };

    await manager.duplicateSession("source-session");

    expect(sessionWorkspaceStore.getWorkspace("duplicate-session")).toMatchObject({ cwd: "/legacy/source" });
  });

  it("session_set_workspace stores an explicit workspace for future turns", async () => {
    const { ctx, manager, sessionWorkspaceStore } = createToolContext();
    const cachedSession = { disconnect: vi.fn() };
    manager.sessionObjects.set("session-1", cachedSession);
    const tool = getTool(ctx, "session_set_workspace");

    await expect(tool.handler({ cwd: "  /explicit/worktree  " }, createInvocation("session_set_workspace")))
      .resolves.toMatchObject({
        success: true,
        sessionId: "session-1",
        cwd: "/explicit/worktree",
        source: "explicit",
      });
    expect(sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({ cwd: "/explicit/worktree" });
    expect(cachedSession.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("session-1")).toBe(false);
  });

  it("session_set_workspace resets to the linked task default", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const sessionDir = join(copilotHome, "session-state", "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), "cwd: /legacy/workspace\n");
    const { ctx, manager, taskStore, sessionWorkspaceStore } = createToolContext();
    manager.deps.copilotHome = copilotHome;
    const task = taskStore.createTask("Linked task");
    taskStore.updateTask(task.id, { cwd: "/task/default-worktree" });
    taskStore.linkSession(task.id, "session-1");
    sessionWorkspaceStore.setWorkspace("session-1", "/explicit/worktree");
    const cachedSession = { disconnect: vi.fn() };
    manager.sessionObjects.set("session-1", cachedSession);
    const tool = getTool(ctx, "session_set_workspace");

    await expect(tool.handler({ reset: true }, createInvocation("session_set_workspace")))
      .resolves.toMatchObject({
        success: true,
        sessionId: "session-1",
        cwd: "/task/default-worktree",
        source: "task-default",
      });
    expect(sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({
      cwd: "/task/default-worktree",
    });
    taskStore.updateTask(task.id, { cwd: "/task/new-default" });
    expect(manager.buildSessionConfig({
      sessionId: "session-1",
      task: taskStore.getTask(task.id),
    }).workingDirectory).toBe("/task/default-worktree");
    expect(cachedSession.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("session-1")).toBe(false);
  });

  it("session_set_workspace requires taskId when resetting a multi-task session", async () => {
    const { ctx, taskStore, sessionWorkspaceStore } = createToolContext();
    const taskA = taskStore.createTask("Task A");
    taskStore.updateTask(taskA.id, { cwd: "/task/a" });
    taskStore.linkSession(taskA.id, "session-1");
    const taskB = taskStore.createTask("Task B");
    taskStore.updateTask(taskB.id, { cwd: "/task/b" });
    taskStore.linkSession(taskB.id, "session-1");
    sessionWorkspaceStore.setWorkspace("session-1", "/override/worktree");
    const tool = getTool(ctx, "session_set_workspace");

    await expect(tool.handler({ reset: true }, createInvocation("session_set_workspace")))
      .resolves.toEqual(toolFailure("Session is linked to multiple tasks; provide taskId when resetting workspace"));
  });

  it("session_set_workspace resets to the selected task default for multi-task sessions", async () => {
    const { ctx, manager, taskStore, sessionWorkspaceStore } = createToolContext();
    const taskA = taskStore.createTask("Task A");
    taskStore.updateTask(taskA.id, { cwd: "/task/a" });
    taskStore.linkSession(taskA.id, "session-1");
    const taskB = taskStore.createTask("Task B");
    taskStore.updateTask(taskB.id, { cwd: "/task/b" });
    taskStore.linkSession(taskB.id, "session-1");
    sessionWorkspaceStore.setWorkspace("session-1", "/override/worktree");
    const cachedSession = { disconnect: vi.fn() };
    manager.sessionObjects.set("session-1", cachedSession);
    const tool = getTool(ctx, "session_set_workspace");

    await expect(tool.handler({ reset: true, taskId: taskB.id }, createInvocation("session_set_workspace")))
      .resolves.toMatchObject({
        success: true,
        sessionId: "session-1",
        cwd: "/task/b",
        source: "task-default",
      });
    expect(sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({ cwd: "/task/b" });
    expect(cachedSession.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("session-1")).toBe(false);
  });

  it("session_set_workspace allows the invoking busy session to set an explicit workspace for future turns", async () => {
    const { ctx, manager, sessionWorkspaceStore } = createToolContext();
    manager.sessionRuns.set("session-1", {
      state: "busy",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });
    const cachedSession = { disconnect: vi.fn() };
    manager.sessionObjects.set("session-1", cachedSession);
    const tool = getTool(ctx, "session_set_workspace");

    await expect(tool.handler({ cwd: "/explicit/worktree" }, createInvocation("session_set_workspace")))
      .resolves.toMatchObject({
        success: true,
        sessionId: "session-1",
        cwd: "/explicit/worktree",
        source: "explicit",
      });
    expect(sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({ cwd: "/explicit/worktree" });
    expect(cachedSession.disconnect).not.toHaveBeenCalled();
    expect(manager.sessionObjects.get("session-1")).toBe(cachedSession);

    manager.setSessionRunState("session-1", "idle");
    manager.flushPendingSessionEviction("session-1");

    expect(cachedSession.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.sessionObjects.has("session-1")).toBe(false);
  });

  it("session_set_workspace returns a blocked result while the target session is busy", async () => {
    const { ctx, manager } = createToolContext();
    manager.sessionRuns.set("session-1", {
      state: "busy",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    });
    const tool = getTool(ctx, "session_set_workspace");

    await expect(tool.handler({ sessionId: "session-1", cwd: "/explicit/worktree" }, createInvocation("session_set_workspace", "session-2")))
      .resolves.toEqual({
        ...toolFailure("Cannot switch workspace for a busy session", {
          detail: "Workspace changes only take effect when the session is idle.",
        }),
        blocked: true,
      });
  });
});
