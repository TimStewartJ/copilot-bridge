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
      head: { kind: "detached", shortSha: "abc1234" },
      dirty: {
        clean: true,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
      siblingWorktrees: [],
      branch: null,
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    })).toEqual({
      repoName: "copilot-bridge",
      branch: expect.stringMatching(/detached.*abc1234/i),
      stateLabel: "clean",
      summaryText: expect.stringMatching(/copilot-bridge.*detached.*abc1234.*clean/i),
      counts: [],
      workspaceKind: "main",
    });
  });

  it("lists each material change count on a dirty branch", () => {
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
