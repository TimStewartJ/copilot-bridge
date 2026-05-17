import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  sessionWorkspaceStore?: Pick<SessionWorkspaceStore, "listWorkspaces" | "deleteWorkspace">;
  workspaceDir?: string;
}): SessionWorkspaceController {
  const dataDir = makeTestDir("session-workspace-controller");
  const runtimePaths = resolveRuntimePaths(process.env, {
    demoMode: opts.workspaceDir !== undefined,
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

describe("SessionWorkspaceController createWorkspaceYamlCwdResolver", () => {
  it("keeps the demo workspace fallback even before the directory exists", async () => {
    const workspaceDir = join(makeTestDir("session-workspace-demo"), "workspace");
    const controller = createController({
      workspaceDir,
      taskStore: { listTasks: () => [], findTaskBySessionId: () => undefined },
    });

    const resolveCwd = controller.createWorkspaceYamlCwdResolver();

    await expect(resolveCwd("session-a", "created_at: 2026-01-01T00:00:00.000Z\n"))
      .resolves.toBe(workspaceDir);
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

    await expect(resolveCwd("session-a", "created_at: 2026-01-01T00:00:00.000Z\n"))
      .resolves.toBe(workspaceDir);
  });
});
