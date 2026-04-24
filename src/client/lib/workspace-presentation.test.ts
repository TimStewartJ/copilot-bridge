import { describe, expect, it } from "vitest";
import {
  areWorkspacePathsEqual,
  buildWorkspaceChoices,
  formatDirtySummary,
  formatGitHead,
} from "./workspace-presentation.js";

describe("workspace-presentation", () => {
  it("formats branch and detached heads", () => {
    expect(formatGitHead({ kind: "branch", name: "feature/worktree" })).toBe("feature/worktree");
    expect(formatGitHead({ kind: "detached", shortSha: "abc1234" })).toBe("detached@abc1234");
  });

  it("formats dirty summaries compactly", () => {
    expect(formatDirtySummary({
      clean: false,
      staged: 2,
      modified: 1,
      untracked: 3,
      conflicts: 0,
    })).toBe("2 staged · 1 modified · 3 untracked");
    expect(formatDirtySummary({
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    })).toBe("Clean working tree");
  });

  it("deduplicates worktree choices and marks the selected path", () => {
    expect(buildWorkspaceChoices({
      status: "ok",
      cwd: "/repo/worktrees/feature",
      repoRoot: "/repo",
      repoName: "copilot-bridge",
      worktreePath: "/repo/worktrees/feature",
      workspaceKind: "linked",
      head: { kind: "branch", name: "feature/worktree" },
      dirty: {
        clean: true,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
      siblingWorktrees: [
        {
          worktreePath: "/repo",
          workspaceKind: "main",
          head: { kind: "branch", name: "main" },
        },
        {
          worktreePath: "/repo/worktrees/feature/",
          workspaceKind: "linked",
          head: { kind: "branch", name: "feature/worktree" },
        },
      ],
      branch: "feature/worktree",
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    }, "/repo/worktrees/feature")).toEqual([
      {
        cwd: "/repo/worktrees/feature",
        workspaceKind: "linked",
        head: { kind: "branch", name: "feature/worktree" },
        selected: true,
      },
      {
        cwd: "/repo",
        workspaceKind: "main",
        head: { kind: "branch", name: "main" },
        selected: false,
      },
    ]);
  });

  it("builds a fallback main-worktree choice from the legacy flat git status shape", () => {
    expect(buildWorkspaceChoices({
      status: "ok",
      cwd: "/repo",
      repoRoot: "/repo",
      repoName: "copilot-bridge",
      branch: "main",
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
    } as any, "/repo")).toEqual([
      {
        cwd: "/repo",
        workspaceKind: "main",
        head: { kind: "branch", name: "main" },
        selected: true,
      },
    ]);
  });

  it("normalizes workspace paths for comparison", () => {
    expect(areWorkspacePathsEqual("C:\\repo\\worktree\\", "c:/repo/worktree")).toBe(true);
    expect(areWorkspacePathsEqual("/repo/main/", "/repo/feature")).toBe(false);
  });
});
