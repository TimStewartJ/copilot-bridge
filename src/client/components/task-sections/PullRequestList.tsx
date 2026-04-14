import type { EnrichedPR, PRRef } from "../../api";
import { PR_STATUS_STYLES } from "../../work-item-styles";
import { GitPullRequest } from "lucide-react";

// ── Props ────────────────────────────────────────────────────────

export interface PullRequestListProps {
  enrichedPRs: EnrichedPR[];
  rawPRs: PRRef[];
  variant?: "compact" | "card";
}

// ── Component ────────────────────────────────────────────────────

export default function PullRequestList({ enrichedPRs, rawPRs, variant = "compact" }: PullRequestListProps) {
  const isCompact = variant === "compact";
  const items = enrichedPRs.length > 0
    ? enrichedPRs
    : rawPRs.map((pr) => ({
        repoId: pr.repoId,
        repoName: pr.repoName ?? null,
        prId: pr.prId,
        provider: pr.provider,
        title: null as string | null,
        status: null as "active" | "completed" | "abandoned" | null,
        createdBy: null as string | null,
        reviewerCount: 0,
        url: "#",
      }));

  return (
    <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
      {items.map((pr) => {
        const statusInfo = PR_STATUS_STYLES[pr.status ?? ""];
        return (
          <a
            key={`${pr.repoId}-${pr.prId}`}
            href={pr.url}
            target="_blank"
            rel="noopener"
            className={
              isCompact
                ? "block px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
                : "block px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
            }
          >
            <div className={`flex items-center ${isCompact ? "gap-1.5" : "gap-2"}`}>
              {isCompact ? (
                <>
                  {pr.status ? (
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusInfo?.dot ?? "bg-text-muted"}`} />
                  ) : (
                    <GitPullRequest size={12} className="text-text-muted" />
                  )}
                </>
              ) : (
                <>
                  {statusInfo ? (
                    <span className={`w-2 h-2 rounded-full shrink-0 ${statusInfo.dot}`} />
                  ) : (
                    <GitPullRequest size={14} className="text-text-muted" />
                  )}
                </>
              )}
              <span className={`text-accent font-medium ${!isCompact ? "text-xs" : ""}`}>#{pr.prId}</span>
              {isCompact && pr.title && (
                <span className="text-text-muted truncate">{pr.title}</span>
              )}
              {!isCompact && statusInfo && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  pr.status === "active" ? "bg-success/15 text-success" :
                  pr.status === "completed" ? "bg-accent/15 text-accent" :
                  "bg-text-muted/15 text-text-muted"
                }`}>
                  {statusInfo.label}
                </span>
              )}
            </div>
            {isCompact && (
              <div className="mt-0.5 ml-5 text-[10px] text-text-faint">
                {pr.repoName || pr.repoId}
                {pr.status && ` · ${pr.status.charAt(0).toUpperCase() + pr.status.slice(1)}`}
              </div>
            )}
            {!isCompact && pr.title && (
              <div className="text-sm text-text-primary mt-1 ml-6 line-clamp-2">{pr.title}</div>
            )}
            {!isCompact && (
              <div className="text-[10px] text-text-faint mt-1 ml-6 flex items-center gap-2">
                <span>{pr.repoName || pr.repoId}</span>
                {pr.createdBy && <span>by {pr.createdBy}</span>}
                {pr.reviewerCount > 0 && <span>{pr.reviewerCount} reviewer{pr.reviewerCount !== 1 ? "s" : ""}</span>}
              </div>
            )}
          </a>
        );
      })}
    </div>
  );
}
