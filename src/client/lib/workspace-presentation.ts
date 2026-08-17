import type { SessionWorkspaceWorktree, TaskGitStatus } from "../api";

type GitStatusOk = Extract<TaskGitStatus, { status: "ok" }>;
type GitHead = GitStatusOk["head"];
type GitDirtyState = GitStatusOk["dirty"];

export function normalizeWorkspacePathForComparison(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized.toLowerCase();
  return normalized.replace(/\/+$/, "").toLowerCase();
}

export function areWorkspacePathsEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return normalizeWorkspacePathForComparison(a) === normalizeWorkspacePathForComparison(b);
}

function getGitHead(status: GitStatusOk): GitHead {
  return status.head;
}

function getWorkspaceKind(status: GitStatusOk): "main" | "linked" {
  return status.workspaceKind;
}

function getWorktreePath(status: GitStatusOk): string {
  return status.worktreePath;
}

function getDirtyState(status: GitStatusOk): GitDirtyState {
  return status.dirty;
}

export function formatGitHead(head?: GitHead | null): string {
  if (!head) return "unknown";
  return head.kind === "branch" ? head.name : `detached@${head.shortSha}`;
}

export function formatDirtySummary(dirty?: GitDirtyState | null): string {
  if (!dirty) return "Working tree state unavailable";
  if (dirty.clean) return "Clean working tree";
  const parts = [
    dirty.staged > 0 ? `${dirty.staged} staged` : null,
    dirty.modified > 0 ? `${dirty.modified} modified` : null,
    dirty.untracked > 0 ? `${dirty.untracked} untracked` : null,
    dirty.conflicts > 0 ? `${dirty.conflicts} conflicts` : null,
  ].filter((value): value is string => !!value);
  return parts.join(" · ");
}

export function buildWorkspaceChoices(
  gitStatus: TaskGitStatus | null | undefined,
  selectedCwd?: string,
): SessionWorkspaceWorktree[] {
  if (!gitStatus || gitStatus.status !== "ok") return [];

  const selected = selectedCwd ? normalizeWorkspacePathForComparison(selectedCwd) : undefined;
  const byPath = new Map<string, SessionWorkspaceWorktree>();
  const addWorktree = (cwd: string, workspaceKind: "main" | "linked", head: GitHead) => {
    const key = normalizeWorkspacePathForComparison(cwd);
    if (byPath.has(key)) return;
    byPath.set(key, {
      cwd,
      workspaceKind,
      head,
      selected: key === selected,
    });
  };

  const worktreePath = getWorktreePath(gitStatus);
  if (worktreePath) {
    addWorktree(worktreePath, getWorkspaceKind(gitStatus), getGitHead(gitStatus));
  }
  for (const sibling of gitStatus.siblingWorktrees) {
    addWorktree(
      sibling.worktreePath,
      sibling.workspaceKind,
      sibling.head,
    );
  }

  return [...byPath.values()];
}

export {
  getDirtyState as getGitDirtyState,
  getGitHead as getGitStatusHead,
  getWorkspaceKind as getGitWorkspaceKind,
  getWorktreePath as getGitWorktreePath,
};
