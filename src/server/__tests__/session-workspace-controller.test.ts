import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveRuntimePaths } from "../runtime-paths.js";
import { SessionWorkspaceController } from "../session-workspace-controller.js";
import type { Task, TaskStore } from "../task-store.js";
import type { SessionWorkspaceStore } from "../session-workspace-store.js";
import { makeTestDir } from "./helpers.js";

function createTask(id: string, sessionId: string, cwd?: string): Task {
  return {
    id,
    title: id,
    kind: "task",
    muted: false,
    status: "active",
    cwd,
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionIds: [sessionId],
    workItems: [],
    pullRequests: [],
  };
}

function createController(opts: {
  taskStore: Pick<TaskStore, "listTasks" | "findTaskBySessionId">;
  sessionWorkspaceStore?: Partial<Pick<SessionWorkspaceStore, "getWorkspace" | "listWorkspaces" | "deleteWorkspace">>;
  workspaceDir?: string;
}): SessionWorkspaceController {
  const dataDir = makeTestDir("session-workspace-controller");
  const runtimePaths = resolveRuntimePaths(process.env, {
    dataDir,
    docsDir: join(dataDir, "docs"),
    copilotHome: join(dataDir, ".copilot"),
    ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
  });
  return new SessionWorkspaceController({
    taskStore: opts.taskStore as TaskStore,
    sessionWorkspaceStore: opts.sessionWorkspaceStore as SessionWorkspaceStore | undefined,
    runtimePaths,
    isSessionBusy: () => false,
    onWorkspaceChange: () => {},
  });
}

function createWorkspaceYaml(cwd?: string): string {
  return [
    "created_at: 2026-01-01T00:00:00.000Z",
    ...(cwd ? [`cwd: ${cwd}`] : []),
    "",
  ].join("\n");
}

describe("SessionWorkspaceController createWorkspaceYamlCwdResolver", () => {
  it("returns undefined when no workspace candidates are available", async () => {
    const controller = createController({
      taskStore: { listTasks: () => [], findTaskBySessionId: () => undefined },
    });

    const resolveCwd = controller.createWorkspaceYamlCwdResolver();

    await expect(resolveCwd("session-a", createWorkspaceYaml()))
      .resolves.toBeUndefined();
  });

  it("uses the task lookup fallback when the task snapshot has no session entry", async () => {
    const workspaceDir = join(makeTestDir("session-workspace-task"), "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const controller = createController({
      taskStore: {
        listTasks: () => [],
        findTaskBySessionId: (sessionId) => createTask("task-a", sessionId, workspaceDir),
      },
    });

    const resolveCwd = controller.createWorkspaceYamlCwdResolver();

    await expect(resolveCwd("session-a", createWorkspaceYaml()))
      .resolves.toBe(workspaceDir);
  });

  it("clears a missing pinned workspace while falling back to workspace yaml", async () => {
    const missingPinnedCwd = join(makeTestDir("session-workspace-missing-pin"), "missing");
    const yamlCwd = join(makeTestDir("session-workspace-yaml"), "workspace");
    mkdirSync(yamlCwd, { recursive: true });
    const deleteWorkspace = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createController({
      taskStore: { listTasks: () => [], findTaskBySessionId: () => undefined },
      sessionWorkspaceStore: {
        listWorkspaces: () => ({
          "session-a": { cwd: missingPinnedCwd, updatedAt: "2026-01-01T00:00:00.000Z" },
        }),
        deleteWorkspace,
      },
    });

    try {
      const resolveCwd = controller.createWorkspaceYamlCwdResolver();

      await expect(resolveCwd("session-a", createWorkspaceYaml(yamlCwd)))
        .resolves.toBe(yamlCwd);
      expect(deleteWorkspace).toHaveBeenCalledWith("session-a");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("pinned workspace is no longer available"));
    } finally {
      warn.mockRestore();
    }
  });

  it("clears a missing pinned workspace while falling back to task cwd", async () => {
    const missingPinnedCwd = join(makeTestDir("session-workspace-missing-pin"), "missing");
    const missingYamlCwd = join(makeTestDir("session-workspace-missing-yaml"), "missing");
    const taskCwd = join(makeTestDir("session-workspace-task"), "workspace");
    mkdirSync(taskCwd, { recursive: true });
    const task = createTask("task-a", "session-a", taskCwd);
    const deleteWorkspace = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createController({
      taskStore: { listTasks: () => [task], findTaskBySessionId: () => task },
      sessionWorkspaceStore: {
        listWorkspaces: () => ({
          "session-a": { cwd: missingPinnedCwd, updatedAt: "2026-01-01T00:00:00.000Z" },
        }),
        deleteWorkspace,
      },
    });

    try {
      const resolveCwd = controller.createWorkspaceYamlCwdResolver();

      await expect(resolveCwd("session-a", createWorkspaceYaml(missingYamlCwd)))
        .resolves.toBe(taskCwd);
      expect(deleteWorkspace).toHaveBeenCalledWith("session-a");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("pinned workspace is no longer available"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SessionWorkspaceController effective cwd resolution", () => {
  it("clears a missing pinned workspace while resolving workspace yaml cwd", () => {
    const missingPinnedCwd = join(makeTestDir("session-workspace-missing-pin"), "missing");
    const yamlCwd = join(makeTestDir("session-workspace-yaml"), "workspace");
    mkdirSync(yamlCwd, { recursive: true });
    const deleteWorkspace = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createController({
      taskStore: { listTasks: () => [], findTaskBySessionId: () => undefined },
      sessionWorkspaceStore: {
        getWorkspace: () => ({ cwd: missingPinnedCwd, updatedAt: "2026-01-01T00:00:00.000Z" }),
        deleteWorkspace,
      },
    });

    try {
      expect(controller.resolveEffectiveSessionCwdFromWorkspaceYaml("session-a", createWorkspaceYaml(yamlCwd)))
        .toBe(yamlCwd);
      expect(deleteWorkspace).toHaveBeenCalledWith("session-a");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("pinned workspace is no longer available"));
    } finally {
      warn.mockRestore();
    }
  });

  it("clears a missing pinned workspace while resolving task cwd", () => {
    const missingPinnedCwd = join(makeTestDir("session-workspace-missing-pin"), "missing");
    const taskCwd = join(makeTestDir("session-workspace-task"), "workspace");
    mkdirSync(taskCwd, { recursive: true });
    const deleteWorkspace = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createController({
      taskStore: { listTasks: () => [], findTaskBySessionId: () => undefined },
      sessionWorkspaceStore: {
        getWorkspace: () => ({ cwd: missingPinnedCwd, updatedAt: "2026-01-01T00:00:00.000Z" }),
        deleteWorkspace,
      },
    });

    try {
      expect(controller.resolveEffectiveSessionCwd({ sessionId: "session-a", task: { cwd: taskCwd } }))
        .toBe(taskCwd);
      expect(deleteWorkspace).toHaveBeenCalledWith("session-a");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("pinned workspace is no longer available"));
    } finally {
      warn.mockRestore();
    }
  });
});
