import { describe, expect, it } from "vitest";
import { describeTaskGitStatusSummary } from "./task-git-status-summary.js";

describe("describeTaskGitStatusSummary", () => {
  it("returns a compact clean summary without count chips", () => {
    expect(describeTaskGitStatusSummary({
      status: "ok",
      cwd: "/repo",
      repoRoot: "/repo",
      repoName: "copilot-bridge",
      worktreePath: "/repo",
      workspaceKind: "main",
      head: { kind: "branch", name: "main" },
      dirty: {
        clean: true,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
      siblingWorktrees: [],
      branch: "main",
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    })).toEqual({
      repoName: "copilot-bridge",
      branch: "main",
      stateLabel: "clean",
      summaryText: "copilot-bridge · main · clean",
      counts: [],
      workspaceKind: "main",
    });
  });

  it("includes only non-zero dirty counts", () => {
    expect(describeTaskGitStatusSummary({
      status: "ok",
      cwd: "/repo",
      repoRoot: "/repo",
      repoName: "copilot-bridge",
      worktreePath: "/repo",
      workspaceKind: "main",
      head: { kind: "branch", name: "feature/task-git-status-ui" },
      dirty: {
        clean: false,
        staged: 2,
        modified: 1,
        untracked: 3,
        conflicts: 1,
      },
      siblingWorktrees: [],
      branch: "feature/task-git-status-ui",
      clean: false,
      staged: 2,
      modified: 1,
      untracked: 3,
      conflicts: 1,
    })).toEqual({
      repoName: "copilot-bridge",
      branch: "feature/task-git-status-ui",
      stateLabel: "dirty",
      summaryText: "copilot-bridge · feature/task-git-status-ui · dirty",
      counts: [
        { key: "staged", label: "staged", shortLabel: "S", value: 2 },
        { key: "modified", label: "modified", shortLabel: "M", value: 1 },
        { key: "untracked", label: "untracked", shortLabel: "U", value: 3 },
        { key: "conflicts", label: "conflicts", shortLabel: "C", value: 1 },
      ],
      workspaceKind: "main",
    });
  });

  it("formats detached HEAD summaries from the structured head payload", () => {
    expect(describeTaskGitStatusSummary({
      status: "ok",
      cwd: "/repo",
      repoRoot: "/repo",
      repoName: "copilot-bridge",
      worktreePath: "/repo",
      workspaceKind: "main",
      head: { kind: "detached", shortSha: "abc1234" },
      dirty: {
        clean: false,
        staged: 0,
        modified: 1,
        untracked: 0,
        conflicts: 0,
      },
      siblingWorktrees: [],
      branch: null,
      clean: false,
      staged: 0,
      modified: 1,
      untracked: 0,
      conflicts: 0,
    })).toEqual({
      repoName: "copilot-bridge",
      branch: "detached@abc1234",
      stateLabel: "dirty",
      summaryText: "copilot-bridge · detached@abc1234 · dirty",
      counts: [
        { key: "modified", label: "modified", shortLabel: "M", value: 1 },
      ],
      workspaceKind: "main",
    });
  });

  it("supports the legacy flat git status shape", () => {
    expect(describeTaskGitStatusSummary({
      status: "ok",
      cwd: "/repo",
      repoRoot: "/repo",
      repoName: "copilot-bridge",
      branch: "main",
      clean: false,
      staged: 2,
      modified: 1,
      untracked: 3,
    } as any)).toEqual({
      repoName: "copilot-bridge",
      branch: "main",
      stateLabel: "dirty",
      summaryText: "copilot-bridge · main · dirty",
      counts: [
        { key: "staged", label: "staged", shortLabel: "S", value: 2 },
        { key: "modified", label: "modified", shortLabel: "M", value: 1 },
        { key: "untracked", label: "untracked", shortLabel: "U", value: 3 },
      ],
      workspaceKind: "main",
    });
  });

  it("hides non-ok states and missing data", () => {
    expect(describeTaskGitStatusSummary(undefined)).toBeNull();
    expect(describeTaskGitStatusSummary(null)).toBeNull();
    expect(describeTaskGitStatusSummary({ status: "not_repo", cwd: "/repo" })).toBeNull();
    expect(describeTaskGitStatusSummary({ status: "not_configured", error: "missing cwd" })).toBeNull();
    expect(describeTaskGitStatusSummary({
      status: "unavailable",
      cwd: "/repo",
      error: "spawn git ENOENT",
    })).toBeNull();
  });
});
