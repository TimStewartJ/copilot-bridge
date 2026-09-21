import type { TaskGitStatus } from "../api";
import { describeTaskGitStatusSummary } from "../lib/task-git-status-summary";
import { cx } from "../design/tokens";
import { Badge } from "../design/primitives";

interface TaskGitStatusSummaryProps {
  gitStatus?: TaskGitStatus | null;
  className?: string;
}

/** Where a workspace stands in git, on one quiet line: repository, branch, and what has changed. */
export default function TaskGitStatusSummary({
  gitStatus,
  className,
}: TaskGitStatusSummaryProps) {
  const summary = describeTaskGitStatusSummary(gitStatus);
  if (!summary) return null;

  return (
    <div className={cx("flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-text-muted", className)}>
      {summary.workspaceKind === "linked" && <Badge title="Linked worktree">worktree</Badge>}
      <span className="min-w-0 truncate" title={summary.summaryText}>
        {summary.summaryText}
      </span>
      {summary.counts.map((count) => (
        <Badge key={count.key} title={`${count.label}: ${count.value}`} className="tabular-nums">
          {count.shortLabel}
          {count.value}
        </Badge>
      ))}
    </div>
  );
}