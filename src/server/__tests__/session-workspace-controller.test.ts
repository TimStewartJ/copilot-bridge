import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveRuntimePaths } from "../runtime-paths.js";
import { SessionWorkspaceController } from "../session-workspace-controller.js";
import type { Task, TaskStore } from "../task-store.js";
import type { SessionWorkspaceStore } from "../session-workspace-store.js";
import { makeTestDir } from "./helpers.js";
import {
  isSessionStatePathSegment,
  parseWorkspaceYamlBoolean,
  parseWorkspaceYamlScalar,
  parseWorkspaceYamlSessionName,
  parseWorkspaceYamlSessionNameMetadata,
} from "../session-workspace-yaml.js";


function createTask(id: string, sessionId: string, cwd?: string): Task {
  return {
    id,
    title: id,
    kind: "task",
    muted: false,
    deferred: false,
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
  sessionWorkspaceStore?: Partial<Pick<SessionWorkspaceStore, "getWorkspace" | "listWorkspaces" | "deleteWorkspace" | "setWorkspace">>;
  workspaceDir?: string;
  copilotHome?: string;
  hostRoots?: string[];
}): SessionWorkspaceController {
  const dataDir = makeTestDir("session-workspace-controller");
  const runtimePaths = resolveRuntimePaths(process.env, {
    dataDir,
    docsDir: join(dataDir, "docs"),
    copilotHome: join(dataDir, ".copilot"),
    workspaceDir: opts.workspaceDir ?? join(dataDir, "neutral-workspace"),
  });
  return new SessionWorkspaceController({
    taskStore: opts.taskStore as TaskStore,
    sessionWorkspaceStore: opts.sessionWorkspaceStore as SessionWorkspaceStore | undefined,
    runtimePaths,
    copilotHome: opts.copilotHome,
    hostRoots: opts.hostRoots,
    isSessionBusy: () => false,
    onWorkspaceChange: () => {},
  });
}

function writeRecordedCwd(copilotHome: string, sessionId: string, cwd: string): void {
  const dir = join(copilotHome, "session-state", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.yaml"), createWorkspaceYaml(cwd));
}

function createWorkspaceYaml(cwd?: string): string {
  return [
    "created_at: 2026-01-01T00:00:00.000Z",
    ...(cwd ? [`cwd: ${cwd}`] : []),
    "",
  ].join("\n");
}

describe("SessionWorkspaceController createWorkspaceYamlCwdResolver", () => {
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

  it("clears a missing pinned workspace while falling back to workspace yaml or task cwd", async () => {
    // falling back to workspace yaml
    {
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
    }

    // falling back to task cwd
    {
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
    }
  });
});

describe("SessionWorkspaceController effective cwd resolution", () => {
  it("clears a missing pinned workspace while resolving workspace yaml cwd or task cwd", () => {
    // resolving workspace yaml cwd
    {
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
    }

    // resolving task cwd
    {
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
    }
  });
});

describe("SessionWorkspaceController neutral workspace", () => {
  const noTasks = { listTasks: () => [], findTaskBySessionId: () => undefined };

  it("uses the neutral workspace instead of an implicit Bridge host cwd", async () => {
    const hostRoot = makeTestDir("session-workspace-host");
    const copilotHome = makeTestDir("session-workspace-home");
    const workspaceDir = join(makeTestDir("session-workspace-neutral"), "workspace");
    writeRecordedCwd(copilotHome, "session-a", hostRoot);
    const controller = createController({ taskStore: noTasks, copilotHome, workspaceDir, hostRoots: [hostRoot] });

    expect(controller.resolveEffectiveSessionCwd({ sessionId: "session-a" })).toBe(workspaceDir);
    expect(existsSync(workspaceDir)).toBe(true);
    expect(controller.resolveEffectiveSessionCwdFromWorkspaceYaml("session-a", createWorkspaceYaml(hostRoot)))
      .toBe(workspaceDir);
    await expect(controller.createWorkspaceYamlCwdResolver()("session-a", createWorkspaceYaml(hostRoot)))
      .resolves.toBe(workspaceDir);
  });

  it("moves an implicit host cwd to the linked task's folder when it has one", () => {
    const hostRoot = makeTestDir("session-workspace-host");
    const copilotHome = makeTestDir("session-workspace-home");
    const taskCwd = makeTestDir("session-workspace-task");
    writeRecordedCwd(copilotHome, "session-a", hostRoot);
    const controller = createController({ taskStore: noTasks, copilotHome, hostRoots: [hostRoot] });

    expect(controller.resolveEffectiveSessionCwd({ sessionId: "session-a", task: { cwd: taskCwd } })).toBe(taskCwd);
  });

  it("keeps an explicit recorded cwd and a recorded neutral workspace", () => {
    const hostRoot = makeTestDir("session-workspace-host");
    const copilotHome = makeTestDir("session-workspace-home");
    const project = makeTestDir("session-workspace-project");
    const workspaceDir = makeTestDir("session-workspace-neutral");
    const taskCwd = makeTestDir("session-workspace-task");
    writeRecordedCwd(copilotHome, "session-project", project);
    writeRecordedCwd(copilotHome, "session-neutral", workspaceDir);
    const controller = createController({ taskStore: noTasks, copilotHome, workspaceDir, hostRoots: [hostRoot] });

    expect(controller.resolveEffectiveSessionCwd({ sessionId: "session-project" })).toBe(project);
    expect(controller.resolveEffectiveSessionCwd({ sessionId: "session-neutral", task: { cwd: taskCwd } }))
      .toBe(workspaceDir);
  });

  it("uses the neutral workspace for new sessions without a task folder", () => {
    const workspaceDir = join(makeTestDir("session-workspace-neutral"), "workspace");
    const controller = createController({ taskStore: noTasks, workspaceDir, hostRoots: [] });

    expect(controller.resolveEffectiveSessionCwd({ task: null })).toBe(workspaceDir);
    expect(controller.resolveEffectiveSessionCwd({ task: { cwd: undefined } })).toBe(workspaceDir);
  });

  it("keeps a pinned or recorded neutral workspace even after it is deleted and the task gains a folder", () => {
    const copilotHome = makeTestDir("session-workspace-home");
    const workspaceDir = join(makeTestDir("session-workspace-neutral"), "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const taskCwd = makeTestDir("session-workspace-task");
    writeRecordedCwd(copilotHome, "session-recorded", workspaceDir);
    const deleteWorkspace = vi.fn();
    const controller = createController({
      taskStore: noTasks,
      copilotHome,
      workspaceDir,
      hostRoots: [],
      sessionWorkspaceStore: {
        getWorkspace: (sessionId) => sessionId === "session-pinned"
          ? { cwd: workspaceDir, updatedAt: "2026-01-01T00:00:00.000Z" }
          : undefined,
        deleteWorkspace,
      },
    });
    rmSync(workspaceDir, { recursive: true, force: true });

    expect(controller.resolveEffectiveSessionCwd({ sessionId: "session-pinned", task: { cwd: taskCwd } })).toBe(workspaceDir);
    expect(existsSync(workspaceDir)).toBe(true);
    rmSync(workspaceDir, { recursive: true, force: true });
    expect(controller.resolveEffectiveSessionCwd({ sessionId: "session-recorded", task: { cwd: taskCwd } })).toBe(workspaceDir);
    expect(existsSync(workspaceDir)).toBe(true);
    expect(deleteWorkspace).not.toHaveBeenCalled();
  });

  it("pins the neutral workspace like any other session workspace", () => {
    const workspaceDir = makeTestDir("session-workspace-neutral");
    const setWorkspace = vi.fn();
    const controller = createController({ taskStore: noTasks, workspaceDir, sessionWorkspaceStore: { setWorkspace } });

    controller.persistSessionWorkspace("session-a", workspaceDir);

    expect(setWorkspace).toHaveBeenCalledWith("session-a", workspaceDir);
  });
});

describe("session workspace yaml parsing", () => {
  it("reads plain and quoted top-level scalar values", () => {
    expect(parseWorkspaceYamlSessionName("created_at: 2026-05-08T10:00:00.000Z\nname: Review catalog adapter\n"))
      .toBe("Review catalog adapter");
    expect(parseWorkspaceYamlSessionName("name: \"Fix Login: Redirect\"\nsummary: Old summary\n"))
      .toBe("Fix Login: Redirect");
    expect(parseWorkspaceYamlScalar("name: null\nsummary: Fallback summary\n", "name")).toBeUndefined();
  });

  it("reads block scalar names and normalizes display whitespace", () => {
    const literal = [
      "created_at: 2026-05-08T10:00:00.000Z",
      "name: |-",
      "  Fix Login",
      "  Redirect",
      "summary: Old summary",
    ].join("\n");
    const folded = [
      "created_at: 2026-05-08T10:00:00.000Z",
      "name: >",
      "  Investigate stale",
      "  session names",
    ].join("\n");

    expect(parseWorkspaceYamlSessionName(literal)).toBe("Fix Login Redirect");
    expect(parseWorkspaceYamlSessionName(folded)).toBe("Investigate stale session names");
  });

  it("falls back to summary and ignores invalid yaml", () => {
    expect(parseWorkspaceYamlSessionName("summary: Summary only\n")).toBe("Summary only");
    expect(parseWorkspaceYamlSessionName("name: [unterminated\n")).toBeUndefined();
  });

  it("reads session name metadata including explicit user naming", () => {
    const content = [
      "name: Manual title",
      "summary: Original prompt",
      "user_named: true",
    ].join("\n");

    expect(parseWorkspaceYamlBoolean(content, "user_named")).toBe(true);
    expect(parseWorkspaceYamlSessionNameMetadata(content)).toEqual({
      name: "Manual title",
      summary: "Original prompt",
      effectiveName: "Manual title",
      userNamed: true,
    });
    expect(parseWorkspaceYamlSessionNameMetadata("summary: Prompt\nuser_named: false\n")).toEqual({
      name: undefined,
      summary: "Prompt",
      effectiveName: "Prompt",
      userNamed: false,
    });
  });

  it("rejects unsafe session-state path segments", () => {
    expect(isSessionStatePathSegment("session-1")).toBe(true);
    expect(isSessionStatePathSegment("..")).toBe(false);
    expect(isSessionStatePathSegment("nested/session")).toBe(false);
    expect(isSessionStatePathSegment("nested\\session")).toBe(false);
  });
});
