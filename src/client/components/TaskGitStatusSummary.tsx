import type { TaskGitStatus } from "../api";
import { describeTaskGitStatusSummary } from "../lib/task-git-status-summary";

interface TaskGitStatusSummaryProps {
  gitStatus?: TaskGitStatus | null;
  className?: string;
}

export default function TaskGitStatusSummary({
  gitStatus,
  className,
}: TaskGitStatusSummaryProps) {
  const summary = describeTaskGitStatusSummary(gitStatus);
  if (!summary) return null;

  return (
    <div className={`flex min-w-0 items-center gap-1.5 flex-wrap text-[10px] text-text-faint ${className ?? ""}`}>
      {summary.workspaceKind === "linked" && (
        <span
          className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium text-accent"
          title="Linked worktree"
        >
          worktree
        </span>
      )}
      <span className="min-w-0 truncate" title={summary.summaryText}>
        {summary.summaryText}
      </span>
      {summary.counts.map((count) => (
        <span
          key={count.key}
          className="shrink-0 rounded-full bg-bg-hover px-1.5 py-0.5 text-[9px] text-text-muted"
          title={`${count.label}: ${count.value}`}
        >
          {count.shortLabel}
          {count.value}
        </span>
      ))}
    </div>
  );
}
