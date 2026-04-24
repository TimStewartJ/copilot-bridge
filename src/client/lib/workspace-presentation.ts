import type { SessionWorkspaceWorktree, TaskGitStatus } from "../api";

type GitHead = Extract<TaskGitStatus, { status: "ok" }>["head"];
type GitDirtyState = Extract<TaskGitStatus, { status: "ok" }>["dirty"];
type LegacyCompatibleOkGitStatus = Extract<TaskGitStatus, { status: "ok" }> & {
  worktreePath?: string;
  workspaceKind?: "main" | "linked";
  head?: GitHead;
  siblingWorktrees?: Array<{
    worktreePath?: string;
    workspaceKind?: "main" | "linked";
    head?: GitHead;
  }>;
};

export function normalizeWorkspacePathForComparison(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized.toLowerCase();
  return normalized.replace(/\/+$/, "").toLowerCase();
}

export function areWorkspacePathsEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return normalizeWorkspacePathForComparison(a) === normalizeWorkspacePathForComparison(b);
}

function buildLegacyGitHead(branch?: string | null): GitHead {
  const name = branch?.trim();
  return name
    ? { kind: "branch", name }
    : { kind: "detached", shortSha: "unknown" };
}

function getGitHead(status: LegacyCompatibleOkGitStatus): GitHead {
  return status.head ?? buildLegacyGitHead(status.branch);
}

function getWorkspaceKind(status: LegacyCompatibleOkGitStatus): "main" | "linked" {
  return status.workspaceKind === "linked" ? "linked" : "main";
}

function getWorktreePath(status: LegacyCompatibleOkGitStatus): string | undefined {
  const worktreePath = typeof status.worktreePath === "string" ? status.worktreePath.trim() : "";
  return worktreePath || status.cwd;
}

function getDirtyState(status: LegacyCompatibleOkGitStatus): GitDirtyState {
  return status.dirty ?? {
    clean: status.clean ?? false,
    staged: status.staged ?? 0,
    modified: status.modified ?? 0,
    untracked: status.untracked ?? 0,
    conflicts: status.conflicts ?? 0,
  };
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

  const compatStatus = gitStatus as LegacyCompatibleOkGitStatus;
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

  const worktreePath = getWorktreePath(compatStatus);
  if (worktreePath) {
    addWorktree(worktreePath, getWorkspaceKind(compatStatus), getGitHead(compatStatus));
  }
  for (const sibling of compatStatus.siblingWorktrees ?? []) {
    if (!sibling.worktreePath || !sibling.head) continue;
    addWorktree(
      sibling.worktreePath,
      sibling.workspaceKind === "linked" ? "linked" : "main",
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
