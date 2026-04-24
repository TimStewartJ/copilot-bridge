import type { TaskGitStatus } from "../api";
import {
  formatGitHead,
  getGitDirtyState,
  getGitStatusHead,
  getGitWorkspaceKind,
} from "./workspace-presentation";

const COUNT_LABELS = {
  staged: { label: "staged", shortLabel: "S" },
  modified: { label: "modified", shortLabel: "M" },
  untracked: { label: "untracked", shortLabel: "U" },
  conflicts: { label: "conflicts", shortLabel: "C" },
} as const;

type CountKey = keyof typeof COUNT_LABELS;

export interface TaskGitStatusCountSummary {
  key: CountKey;
  label: string;
  shortLabel: string;
  value: number;
}

export interface TaskGitStatusSummaryDescriptor {
  repoName: string;
  branch: string;
  stateLabel: "clean" | "dirty";
  summaryText: string;
  counts: TaskGitStatusCountSummary[];
  workspaceKind: "main" | "linked";
}

export function describeTaskGitStatusSummary(status: TaskGitStatus | null | undefined): TaskGitStatusSummaryDescriptor | null {
  if (!status || status.status !== "ok") return null;

  const dirty = getGitDirtyState(status);
  const stateLabel = dirty.clean ? "clean" : "dirty";
  const branch = formatGitHead(getGitStatusHead(status));
  const counts = dirty.clean
    ? []
    : (Object.entries(COUNT_LABELS) as [CountKey, (typeof COUNT_LABELS)[CountKey]][])
      .flatMap(([key, meta]) => (
        dirty[key] > 0
          ? [{ key, label: meta.label, shortLabel: meta.shortLabel, value: dirty[key] }]
          : []
      ));

  return {
    repoName: status.repoName,
    branch,
    stateLabel,
    summaryText: `${status.repoName} · ${branch} · ${stateLabel}`,
    counts,
    workspaceKind: getGitWorkspaceKind(status),
  };
}
