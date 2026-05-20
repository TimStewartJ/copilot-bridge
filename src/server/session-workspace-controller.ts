import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RuntimePaths } from "./runtime-paths.js";
import type { SessionWorkspaceStore } from "./session-workspace-store.js";
import type { Task, TaskStore } from "./task-store.js";
import { parseWorkspaceCwd } from "./session-formatting.js";
import {
  createWorkspaceAvailabilityLookup,
  getWorkspaceAvailability,
  resolveAvailableWorkspaceCwd,
  resolveAvailableWorkspaceCwdAsync,
} from "./session-workspace-availability.js";

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

    return undefined;
  }

  resolveEffectiveSessionCwdFromWorkspaceYaml(
    sessionId: string,
    workspaceYamlContent: string,
  ): string | undefined {
    const linkedTask = this.findLinkedTask(sessionId);
    return this.resolvePersistedSessionCwd(sessionId)
      ?? resolveAvailableWorkspaceCwd(parseWorkspaceCwd(workspaceYamlContent))
      ?? resolveAvailableWorkspaceCwd(linkedTask?.cwd);
  }

  createWorkspaceYamlCwdResolver(): (sessionId: string, workspaceYamlContent: string) => Promise<string | undefined> {
    const getAvailability = createWorkspaceAvailabilityLookup();
    const pinnedWorkspaces = this.deps.sessionWorkspaceStore?.listWorkspaces?.() ?? {};
    const taskCwdBySessionId = new Map<string, string | undefined>();
    const multiTaskSessionIds = new Set<string>();
    const listedTasks = this.deps.taskStore.listTasks?.() ?? [];
    for (const task of listedTasks) {
      for (const sessionId of task.sessionIds) {
        if (multiTaskSessionIds.has(sessionId)) continue;
        if (taskCwdBySessionId.has(sessionId)) {
          taskCwdBySessionId.delete(sessionId);
          multiTaskSessionIds.add(sessionId);
          continue;
        }
        taskCwdBySessionId.set(sessionId, task.cwd);
      }
    }
    return async (sessionId, workspaceYamlContent) => {
      const pinnedCwd = pinnedWorkspaces[sessionId]?.cwd;
      const pinnedAvailability = await getAvailability(pinnedCwd);
      if (pinnedAvailability?.available) return pinnedAvailability.cwd;

      if (pinnedAvailability) {
        if (pinnedAvailability.clearStalePin) {
          // Missing pins are stale preferences; clear them so future SDK resumes do not reuse an invalid cwd.
          this.deps.sessionWorkspaceStore?.deleteWorkspace(sessionId);
        }
        console.warn(
          `[workspace] Session ${sessionId.slice(0, 8)} pinned workspace is no longer available; falling back: ${pinnedAvailability.cwd}`,
        );
      }

      const linkedTaskCwd = multiTaskSessionIds.has(sessionId)
        ? undefined
        : (taskCwdBySessionId.has(sessionId)
            ? taskCwdBySessionId.get(sessionId)
            : this.deps.taskStore.findTaskBySessionId?.(sessionId)?.cwd);
      return await resolveAvailableWorkspaceCwdAsync(parseWorkspaceCwd(workspaceYamlContent), getAvailability)
        ?? await resolveAvailableWorkspaceCwdAsync(linkedTaskCwd, getAvailability);
    };
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
      // Keep persisted pins aligned with the cwd we can safely pass to the SDK.
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
