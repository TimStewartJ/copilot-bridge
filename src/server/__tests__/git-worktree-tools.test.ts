import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readGitWorktreeStatus } from "../git-worktree-status.js";
import { createGitWorktreeToolDefinitions } from "../tools/git-worktree-tools.js";
import { createTestApp } from "./test-app.js";
import { testPath } from "./test-paths.js";

vi.mock("../git-worktree-status.js", () => ({
  readGitWorktreeStatus: vi.fn(),
}));

const readGitWorktreeStatusMock = vi.mocked(readGitWorktreeStatus);

function getTool(ctx: ReturnType<typeof createTestApp>["ctx"]) {
  const tool = createGitWorktreeToolDefinitions(ctx)
    .find((candidate) => candidate.name === "git_worktree_release");
  if (!tool) throw new Error("git_worktree_release tool not found");
  return tool;
}

function invocation(sessionId = "current-session") {
  return { sessionId, requestId: "tool-call-1" } as any;
}

function linkedWorktreeStatus(mainWorktreePath: string, worktreePath: string) {
  return {
    status: "ok" as const,
    cwd: worktreePath,
    repoRoot: mainWorktreePath,
    repoName: "repo",
    worktreePath,
    workspaceKind: "linked" as const,
    head: { kind: "branch" as const, name: "users/test/feature" },
    dirty: { clean: true, staged: 0, modified: 0, untracked: 0, conflicts: 0 },
    siblingWorktrees: [{
      worktreePath: mainWorktreePath,
      workspaceKind: "main" as const,
      head: { kind: "branch" as const, name: "main" },
    }],
    branch: "users/test/feature",
    clean: true,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
  };
}

describe("git_worktree_release", () => {
  it("repoints matching task and session workspaces without changing Git", async () => {
    const { ctx } = createTestApp();
    const mainWorktreePath = testPath("repo-main");
    const worktreePath = testPath("repo-worktrees", "feature");
    const subdir = join(worktreePath, "src");
    readGitWorktreeStatusMock.mockResolvedValue(
      linkedWorktreeStatus(mainWorktreePath, worktreePath),
    );

    const rootTask = ctx.taskStore.createTask("Root workspace");
    ctx.taskStore.updateTask(rootTask.id, { cwd: worktreePath });
    ctx.taskStore.linkSession(rootTask.id, "current-session");
    ctx.taskStore.linkSession(rootTask.id, "legacy-session");
    const subdirTask = ctx.taskStore.createTask("Subdirectory workspace");
    ctx.taskStore.updateTask(subdirTask.id, { cwd: subdir });
    const otherTask = ctx.taskStore.createTask("Other workspace");
    ctx.taskStore.updateTask(otherTask.id, { cwd: testPath("other-repo") });

    ctx.sessionWorkspaceStore.setWorkspace("pinned-session", worktreePath);
    ctx.sessionWorkspaceStore.setWorkspace("subdir-session", subdir);

    const effectiveWorkspaces = new Map<string, string>([
      ["current-session", worktreePath],
      ["legacy-session", join(worktreePath, "legacy")],
    ]);
    ctx.sessionManager.getEffectiveSessionCwd = vi.fn(
      (sessionId: string) => effectiveWorkspaces.get(sessionId),
    );
    ctx.sessionManager.isSessionBusy = vi.fn(() => false);
    ctx.sessionManager.setSessionWorkspace = vi.fn((sessionId: string, cwd: string) => {
      ctx.sessionWorkspaceStore.setWorkspace(sessionId, cwd);
      return {
        cwd,
        source: "explicit" as const,
        message: `Session workspace set to ${cwd} for future turns`,
      };
    });

    const result = await getTool(ctx).handler({}, invocation()) as any;

    expect(readGitWorktreeStatusMock).toHaveBeenCalledWith(worktreePath);
    expect(ctx.taskStore.getTask(rootTask.id)?.cwd).toBe(mainWorktreePath);
    expect(ctx.taskStore.getTask(subdirTask.id)?.cwd).toBe(join(mainWorktreePath, "src"));
    expect(ctx.taskStore.getTask(otherTask.id)?.cwd).toBe(testPath("other-repo"));
    expect(ctx.sessionWorkspaceStore.getWorkspace("current-session")?.cwd).toBe(mainWorktreePath);
    expect(ctx.sessionWorkspaceStore.getWorkspace("legacy-session")?.cwd)
      .toBe(join(mainWorktreePath, "legacy"));
    expect(ctx.sessionWorkspaceStore.getWorkspace("pinned-session")?.cwd).toBe(mainWorktreePath);
    expect(ctx.sessionWorkspaceStore.getWorkspace("subdir-session")?.cwd)
      .toBe(join(mainWorktreePath, "src"));
    expect(result).toMatchObject({
      success: true,
      changed: true,
      terminal: true,
      worktreePath,
      mainWorktreePath,
    });
    expect(result.summary).toContain("Git and files were not changed");
  });

  it("rejects releasing the repository's main worktree", async () => {
    const { ctx } = createTestApp();
    const mainWorktreePath = testPath("repo-main");
    readGitWorktreeStatusMock.mockResolvedValue({
      ...linkedWorktreeStatus(mainWorktreePath, mainWorktreePath),
      workspaceKind: "main",
    });
    ctx.sessionManager.getEffectiveSessionCwd = vi.fn(() => mainWorktreePath);

    const result = await getTool(ctx).handler({}, invocation()) as any;

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("main Git worktree cannot be released");
  });

  it("makes no changes when another affected session is busy", async () => {
    const { ctx } = createTestApp();
    const mainWorktreePath = testPath("repo-main");
    const worktreePath = testPath("repo-worktrees", "feature");
    readGitWorktreeStatusMock.mockResolvedValue(
      linkedWorktreeStatus(mainWorktreePath, worktreePath),
    );
    const task = ctx.taskStore.createTask("Busy workspace");
    ctx.taskStore.updateTask(task.id, { cwd: worktreePath });
    ctx.taskStore.linkSession(task.id, "busy-session");
    ctx.sessionWorkspaceStore.setWorkspace("busy-session", worktreePath);
    ctx.sessionManager.getEffectiveSessionCwd = vi.fn(
      (sessionId: string) => sessionId === "current-session" ? worktreePath : undefined,
    );
    ctx.sessionManager.isSessionBusy = vi.fn(
      (sessionId: string) => sessionId === "busy-session",
    );
    ctx.sessionManager.setSessionWorkspace = vi.fn();

    const result = await getTool(ctx).handler({}, invocation()) as any;

    expect(result.resultType).toBe("failure");
    expect(result.blockedSessionIds).toEqual(["busy-session"]);
    expect(result.textResultForLlm).toContain("No references were changed");
    expect(ctx.taskStore.getTask(task.id)?.cwd).toBe(worktreePath);
    expect(ctx.sessionManager.setSessionWorkspace).not.toHaveBeenCalled();
  });

  it("allows the invoking busy session to release itself for the next turn", async () => {
    const { ctx } = createTestApp();
    const mainWorktreePath = testPath("repo-main");
    const worktreePath = testPath("repo-worktrees", "feature");
    readGitWorktreeStatusMock.mockResolvedValue(
      linkedWorktreeStatus(mainWorktreePath, worktreePath),
    );
    ctx.sessionManager.getEffectiveSessionCwd = vi.fn(() => worktreePath);
    ctx.sessionManager.isSessionBusy = vi.fn(() => true);
    ctx.sessionManager.setSessionWorkspace = vi.fn((_sessionId: string, cwd: string) => ({
      cwd,
      source: "explicit" as const,
      message: `Session workspace set to ${cwd} for future turns`,
    }));

    const result = await getTool(ctx).handler({}, invocation()) as any;

    expect(ctx.sessionManager.setSessionWorkspace).toHaveBeenCalledWith(
      "current-session",
      mainWorktreePath,
      { allowDuringActiveTurn: true },
    );
    expect(result).toMatchObject({
      success: true,
      terminal: true,
      toolNextAction: "respond",
    });
  });
});
