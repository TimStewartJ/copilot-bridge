import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { createBridgeSessionStateStore } from "../bridge-session-state-store.js";
import { createChecklistStore } from "../checklist-store.js";
import { createFeedStore } from "../feed-store.js";
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

  function createWorkspace(root: string, name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
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
      bridgeSessionStateStore: createBridgeSessionStateStore(db),
      readStateStore: createReadStateStore(db),
      checklistStore: createChecklistStore(db, globalBus),
      feedStore: createFeedStore(db, globalBus),
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
    const persistedWorkspace = createWorkspace(copilotHome, "persisted-workspace");
    const legacyWorkspace = createWorkspace(copilotHome, "legacy-workspace");
    const taskWorkspace = createWorkspace(copilotHome, "task-workspace");
    const sessionDir = join(copilotHome, "session-state", "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), `cwd: ${legacyWorkspace}\n`);

    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Pinned task");
    taskStore.updateTask(task.id, { cwd: taskWorkspace });
    taskStore.linkSession(task.id, "session-1");
    sessionWorkspaceStore.setWorkspace("session-1", persistedWorkspace);

    const config = manager.buildSessionConfig({ sessionId: "session-1", task: taskStore.getTask(task.id) });
    expect(config.workingDirectory).toBe(persistedWorkspace);
  });

  it("falls back to task cwd and clears a missing persisted session workspace", () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const taskWorkspace = createWorkspace(copilotHome, "task-workspace");
    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Fallback task");
    taskStore.updateTask(task.id, { cwd: taskWorkspace });
    taskStore.linkSession(task.id, "session-1");
    sessionWorkspaceStore.setWorkspace("session-1", join(copilotHome, "missing-staging-worktree"));

    const config = manager.buildSessionConfig({ sessionId: "session-1", task: taskStore.getTask(task.id) });

    expect(config.workingDirectory).toBe(taskWorkspace);
    expect(sessionWorkspaceStore.getWorkspace("session-1")).toBeUndefined();
  });

  it("falls back from legacy yaml to task cwd to demo workspace", () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const legacyWorkspace = createWorkspace(copilotHome, "legacy-workspace");
    const taskWorkspace = createWorkspace(copilotHome, "task-workspace");
    const demoWorkspace = createWorkspace(copilotHome, "demo-workspace");
    const runtimePaths = {
      demoMode: true,
      workspaceDir: demoWorkspace,
      dataDir: join(copilotHome, "demo-data"),
      docsDir: join(copilotHome, "demo-docs"),
      copilotHome,
      env: {},
    };
    const sessionDir = join(copilotHome, "session-state", "session-legacy");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), `cwd: ${legacyWorkspace}\n`);

    const { manager, taskStore } = createManager({ copilotHome, runtimePaths });
    const task = taskStore.createTask("Fallback task");
    taskStore.updateTask(task.id, { cwd: taskWorkspace });

    expect(manager.buildSessionConfig({ sessionId: "session-legacy", task: taskStore.getTask(task.id) }).workingDirectory)
      .toBe(legacyWorkspace);
    expect(manager.buildSessionConfig({ task: taskStore.getTask(task.id) }).workingDirectory)
      .toBe(taskWorkspace);
    expect(manager.buildSessionConfig().workingDirectory).toBe(demoWorkspace);
  });

  it("omits workingDirectory when all configured workspace candidates are missing", () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const sessionDir = join(copilotHome, "session-state", "session-missing");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), `cwd: ${join(copilotHome, "missing-legacy")}\n`);

    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Missing fallback task");
    taskStore.updateTask(task.id, { cwd: join(copilotHome, "missing-task") });
    sessionWorkspaceStore.setWorkspace("session-missing", join(copilotHome, "missing-pinned"));

    expect(manager.buildSessionConfig({ sessionId: "session-missing", task: taskStore.getTask(task.id) }).workingDirectory)
      .toBeUndefined();
    expect(sessionWorkspaceStore.getWorkspace("session-missing")).toBeUndefined();
  });

  it("uses task cwd in disk session lists when the persisted workspace is missing", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const taskWorkspace = createWorkspace(copilotHome, "task-workspace");
    const sessionDir = join(copilotHome, "session-state", "session-listed");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), `cwd: ${join(copilotHome, "missing-legacy")}\nsummary: Listed session\n`);

    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Listed task");
    taskStore.updateTask(task.id, { cwd: taskWorkspace });
    taskStore.linkSession(task.id, "session-listed");
    sessionWorkspaceStore.setWorkspace("session-listed", join(copilotHome, "missing-pinned"));

    const sessions = await manager.listSessionsFromDisk({ includeArchived: true });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-listed",
        context: { cwd: taskWorkspace },
      }),
    ]);
    expect(sessionWorkspaceStore.getWorkspace("session-listed")).toBeUndefined();
  });

  it("pins the task cwd for new task sessions", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const taskWorkspace = createWorkspace(copilotHome, "task-worktree");
    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Pinned task");
    taskStore.updateTask(task.id, { cwd: taskWorkspace });

    manager.client = {
      createSession: vi.fn(async () => ({ sessionId: "task-session", disconnect: vi.fn() })),
    };

    await manager.createTaskSession(task.id, task.title, task.workItems, [], task.notes, task.cwd);

    expect(sessionWorkspaceStore.getWorkspace("task-session")).toMatchObject({ cwd: taskWorkspace });
  });

  it("keeps existing task sessions pinned when the task default changes later", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const taskWorkspaceV1 = createWorkspace(copilotHome, "task-worktree-v1");
    const taskWorkspaceV2 = createWorkspace(copilotHome, "task-worktree-v2");
    const { manager, taskStore, sessionWorkspaceStore } = createManager({ copilotHome });
    const task = taskStore.createTask("Pinned task");
    taskStore.updateTask(task.id, { cwd: taskWorkspaceV1 });

    manager.client = {
      createSession: vi.fn(async () => ({ sessionId: "task-session", disconnect: vi.fn() })),
    };

    await manager.createTaskSession(task.id, task.title, task.workItems, [], task.notes, task.cwd);
    taskStore.updateTask(task.id, { cwd: taskWorkspaceV2 });

    expect(sessionWorkspaceStore.getWorkspace("task-session")).toMatchObject({ cwd: taskWorkspaceV1 });
    expect(manager.buildSessionConfig({
      sessionId: "task-session",
      task: taskStore.getTask(task.id),
    }).workingDirectory).toBe(taskWorkspaceV1);
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

  it("copies legacy workspace state when forking a session", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-workspace-"));
    tempDirs.push(copilotHome);
    const legacyWorkspace = createWorkspace(copilotHome, "legacy-source-workspace");
    const sourceDir = join(copilotHome, "session-state", "source-session");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "workspace.yaml"), `cwd: ${legacyWorkspace}\n`);

    const { manager, sessionWorkspaceStore } = createManager({ copilotHome });
    manager.client = {
      rpc: {
        sessions: {
          fork: vi.fn(async () => ({ sessionId: "forked-session" })),
        },
      },
    };

    await manager.forkSession("source-session");

    expect(sessionWorkspaceStore.getWorkspace("forked-session")).toMatchObject({ cwd: legacyWorkspace });
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
    const taskDefaultWorkspace = createWorkspace(copilotHome, "task-default-worktree");
    const sessionDir = join(copilotHome, "session-state", "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), "cwd: /legacy/workspace\n");
    const { ctx, manager, taskStore, sessionWorkspaceStore } = createToolContext();
    manager.deps.copilotHome = copilotHome;
    const task = taskStore.createTask("Linked task");
    taskStore.updateTask(task.id, { cwd: taskDefaultWorkspace });
    taskStore.linkSession(task.id, "session-1");
    sessionWorkspaceStore.setWorkspace("session-1", "/explicit/worktree");
    const cachedSession = { disconnect: vi.fn() };
    manager.sessionObjects.set("session-1", cachedSession);
    const tool = getTool(ctx, "session_set_workspace");

    await expect(tool.handler({ reset: true }, createInvocation("session_set_workspace")))
      .resolves.toMatchObject({
        success: true,
        sessionId: "session-1",
        cwd: taskDefaultWorkspace,
        source: "task-default",
      });
    expect(sessionWorkspaceStore.getWorkspace("session-1")).toMatchObject({
      cwd: taskDefaultWorkspace,
    });
    taskStore.updateTask(task.id, { cwd: "/task/new-default" });
    expect(manager.buildSessionConfig({
      sessionId: "session-1",
      task: taskStore.getTask(task.id),
    }).workingDirectory).toBe(taskDefaultWorkspace);
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

describe("SessionManager forkSession", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createManager(copilotHome: string) {
    const db = openMemoryDatabase();
    const globalBus = createGlobalBus();
    const taskStore = createTaskStore(db, globalBus);
    const sessionWorkspaceStore = createSessionWorkspaceStore(db);
    const manager = new SessionManager({
      tools: [],
      globalBus,
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      sessionWorkspaceStore,
      taskStore,
      settingsStore: createSettingsStore(db),
      config: { sessionMcpServers: {} },
      copilotHome,
    });
    return { manager: manager as any, sessionWorkspaceStore };
  }

  it("delegates full-session forks to the native SDK RPC", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-fork-"));
    tempDirs.push(copilotHome);
    const sourceWorkspace = join(copilotHome, "source-workspace");
    mkdirSync(sourceWorkspace, { recursive: true });
    const { manager, sessionWorkspaceStore } = createManager(copilotHome);
    sessionWorkspaceStore.setWorkspace("source-session", sourceWorkspace);
    const fork = vi.fn(async () => ({ sessionId: "forked-session" }));
    manager.client = {
      rpc: { sessions: { fork } },
    };

    const result = await manager.forkSession("source-session");

    expect(result).toEqual({ sessionId: "forked-session" });
    expect(fork).toHaveBeenCalledWith({ sessionId: "source-session" });
    expect(sessionWorkspaceStore.getWorkspace("forked-session")).toMatchObject({ cwd: sourceWorkspace });
    expect(existsSync(join(copilotHome, "session-state", "forked-session", "workspace.yaml"))).toBe(false);
  });

  it("passes safe raw event boundaries to the native SDK fork RPC", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-fork-boundary-"));
    tempDirs.push(copilotHome);
    const { manager } = createManager(copilotHome);
    const fork = vi.fn(async () => ({ sessionId: "bounded-fork" }));
    manager.client = {
      rpc: { sessions: { fork } },
    };

    await manager.forkSession("source-session", { toEventId: " next-event " });

    expect(fork).toHaveBeenCalledWith({ sessionId: "source-session", toEventId: "next-event" });
  });

  it("sets a CLI-owned fork name through one resumed session", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-fork-name-"));
    tempDirs.push(copilotHome);
    const { manager } = createManager(copilotHome);
    const sessionDir = join(copilotHome, "session-state", "forked-session");
    mkdirSync(sessionDir, { recursive: true });
    const disconnect = vi.fn();
    let visibleName: string | null = null;
    const set = vi.fn(async ({ name }: { name: string }) => {
      visibleName = name;
    });
    const get = vi.fn(async () => ({ name: visibleName }));
    const resumeSession = vi.fn(async () => ({
      disconnect,
      rpc: { name: { set, get } },
    }));
    manager.client = {
      resumeSession,
    };

    await manager.setSessionName("forked-session", "Fork of Original session");

    const workspacePath = join(copilotHome, "session-state", "forked-session", "workspace.yaml");
    expect(existsSync(workspacePath)).toBe(false);
    expect(resumeSession).toHaveBeenCalledWith("forked-session", expect.objectContaining({ disableResume: true }));
    expect(set).toHaveBeenCalledWith({ name: "Fork of Original session" });
    expect(get).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

});
