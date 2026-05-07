import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { RuntimePaths } from "./runtime-paths.js";
import type { SessionWorkspaceStore } from "./session-workspace-store.js";
import type { Task, TaskStore } from "./task-store.js";
import { parseWorkspaceCwd } from "./session-formatting.js";

export type SessionWorkspaceChangeOptions = { allowDuringActiveTurn?: boolean };

export interface SessionWorkspaceControllerDeps {
  sessionWorkspaceStore?: SessionWorkspaceStore;
  taskStore: TaskStore;
  copilotHome?: string;
  runtimePaths?: RuntimePaths;
  isSessionBusy(sessionId: string): boolean;
  onWorkspaceChange(sessionId: string, opts: { busy: boolean }): void;
}

export interface SetSessionWorkspaceResult {
  cwd: string;
  source: "explicit";
  message: string;
}

export interface ResetSessionWorkspaceResult {
  cwd: string;
  source: "task-default";
  message: string;
}

function isDemoMode(runtimePaths?: RuntimePaths): boolean {
  return runtimePaths?.demoMode ?? false;
}

function resolveDemoWorkspaceDir(runtimePaths?: RuntimePaths): string | undefined {
  if (!isDemoMode(runtimePaths)) return undefined;
  return runtimePaths?.workspaceDir ?? (runtimePaths ? join(resolve(runtimePaths.dataDir), "workspace") : undefined);
}

function getFsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getWorkspaceAvailability(cwd?: string | null): {
  cwd: string;
  available: boolean;
  clearStalePin: boolean;
} | undefined {
  const normalized = cwd?.trim();
  if (!normalized) return undefined;
  try {
    return {
      cwd: normalized,
      available: statSync(normalized).isDirectory(),
      clearStalePin: true,
    };
  } catch (error) {
    const code = getFsErrorCode(error);
    return {
      cwd: normalized,
      available: false,
      clearStalePin: code === "ENOENT" || code === "ENOTDIR",
    };
  }
}

function resolveAvailableWorkspaceCwd(cwd?: string | null): string | undefined {
  const availability = getWorkspaceAvailability(cwd);
  return availability?.available ? availability.cwd : undefined;
}

export class SessionWorkspaceController {
  constructor(private readonly deps: SessionWorkspaceControllerDeps) {}

  getCopilotHome(): string {
    return this.deps.copilotHome ?? join(homedir(), ".copilot");
  }

  getSessionStateDir(sessionId: string): string {
    return join(this.getCopilotHome(), "session-state", sessionId);
  }

  getLegacyWorkspaceCwd(sessionId: string): string | undefined {
    const yamlPath = join(this.getSessionStateDir(sessionId), "workspace.yaml");
    try {
      return parseWorkspaceCwd(readFileSync(yamlPath, "utf-8"));
    } catch {
      return undefined;
    }
  }

  findLinkedTask(sessionId: string): Task | undefined {
    const linkedTasks = this.listLinkedTasks(sessionId);
    return linkedTasks.length === 1 ? linkedTasks[0] : undefined;
  }

  listLinkedTasks(sessionId: string): Task[] {
    const listedTasks = this.deps.taskStore.listTasks?.().filter((task) => task.sessionIds.includes(sessionId)) ?? [];
    if (listedTasks.length > 0) return listedTasks;
    const linkedTask = this.deps.taskStore.findTaskBySessionId?.(sessionId);
    return linkedTask ? [linkedTask] : [];
  }

  resolveResetTaskCwd(
    sessionId: string,
    opts: { taskCwd?: string; taskId?: string },
  ): string | undefined {
    const explicitTaskCwd = opts.taskCwd?.trim();
    if (explicitTaskCwd) return explicitTaskCwd;

    const explicitTaskId = opts.taskId?.trim();
    if (explicitTaskId) {
      const task = this.deps.taskStore.getTask?.(explicitTaskId);
      if (!task) throw new Error("Task not found");
      if (!task.sessionIds.includes(sessionId)) {
        throw new Error("Task is not linked to session");
      }
      return task.cwd?.trim();
    }

    const linkedTasks = this.listLinkedTasks(sessionId);
    if (linkedTasks.length > 1) {
      throw new Error("Session is linked to multiple tasks; provide taskId when resetting workspace");
    }
    return linkedTasks[0]?.cwd?.trim();
  }

  resolveEffectiveSessionCwd(opts: { sessionId?: string; task?: Pick<Task, "cwd"> | null }): string | undefined {
    const { sessionId, task } = opts;
    const persistedCwd = this.resolvePersistedSessionCwd(sessionId);
    if (persistedCwd) return persistedCwd;

    const legacyCwd = sessionId ? this.getLegacyWorkspaceCwd(sessionId) : undefined;
    const availableLegacyCwd = resolveAvailableWorkspaceCwd(legacyCwd);
    if (availableLegacyCwd) return availableLegacyCwd;

    const taskCwd = resolveAvailableWorkspaceCwd(task?.cwd);
    if (taskCwd) return taskCwd;

    return resolveDemoWorkspaceDir(this.deps.runtimePaths);
  }

  resolveEffectiveSessionCwdFromWorkspaceYaml(
    sessionId: string,
    workspaceYamlContent: string,
  ): string | undefined {
    const linkedTask = this.findLinkedTask(sessionId);
    return this.resolvePersistedSessionCwd(sessionId)
      ?? resolveAvailableWorkspaceCwd(parseWorkspaceCwd(workspaceYamlContent))
      ?? resolveAvailableWorkspaceCwd(linkedTask?.cwd)
      ?? resolveDemoWorkspaceDir(this.deps.runtimePaths);
  }

  persistSessionWorkspace(sessionId: string, cwd?: string): void {
    if (!cwd?.trim()) return;
    this.deps.sessionWorkspaceStore?.setWorkspace(sessionId, cwd);
  }

  setSessionWorkspace(
    sessionId: string,
    cwd: string,
    opts: SessionWorkspaceChangeOptions = {},
  ): SetSessionWorkspaceResult {
    const normalizedCwd = cwd.trim();
    if (!normalizedCwd) {
      throw new Error("cwd is required");
    }
    this.ensureSessionWorkspaceCanChange(sessionId, opts);
    const store = this.deps.sessionWorkspaceStore;
    if (!store) {
      throw new Error("Session workspace store is not configured");
    }
    store.setWorkspace(sessionId, normalizedCwd);
    this.applySessionWorkspaceChange(sessionId, opts);
    return {
      cwd: normalizedCwd,
      source: "explicit",
      message: `Session workspace set to ${normalizedCwd} for future turns`,
    };
  }

  resetSessionWorkspace(
    sessionId: string,
    opts: SessionWorkspaceChangeOptions & { taskCwd?: string; taskId?: string } = {},
  ): ResetSessionWorkspaceResult {
    this.ensureSessionWorkspaceCanChange(sessionId, opts);
    const taskCwd = this.resolveResetTaskCwd(sessionId, opts);
    if (!taskCwd) {
      throw new Error("Linked task has no default workspace");
    }
    const store = this.deps.sessionWorkspaceStore;
    if (!store) {
      throw new Error("Session workspace store is not configured");
    }
    store.setWorkspace(sessionId, taskCwd);
    this.applySessionWorkspaceChange(sessionId, opts);
    return {
      cwd: taskCwd,
      source: "task-default",
      message: `Session workspace reset to linked task default ${taskCwd}`,
    };
  }

  private ensureSessionWorkspaceCanChange(
    sessionId: string,
    opts: SessionWorkspaceChangeOptions = {},
  ): void {
    if (this.deps.isSessionBusy(sessionId) && !opts.allowDuringActiveTurn) {
      throw new Error("Cannot switch workspace for a busy session");
    }
  }

  private resolvePersistedSessionCwd(sessionId?: string): string | undefined {
    if (!sessionId) return undefined;
    const storedWorkspace = this.deps.sessionWorkspaceStore?.getWorkspace(sessionId);
    const cwd = storedWorkspace?.cwd?.trim();
    if (!cwd) return undefined;
    const availability = getWorkspaceAvailability(cwd);
    if (availability?.available) return availability.cwd;

    if (availability?.clearStalePin) {
      this.deps.sessionWorkspaceStore?.deleteWorkspace(sessionId);
    }
    console.warn(
      `[workspace] Session ${sessionId.slice(0, 8)} pinned workspace is no longer available; falling back: ${cwd}`,
    );
    return undefined;
  }

  private applySessionWorkspaceChange(
    sessionId: string,
    opts: SessionWorkspaceChangeOptions = {},
  ): void {
    this.ensureSessionWorkspaceCanChange(sessionId, opts);
    this.deps.onWorkspaceChange(sessionId, { busy: this.deps.isSessionBusy(sessionId) });
  }
}
