import { useState } from "react";
import type { EnrichedPR, PRRef, ProviderName } from "../../api";
import { linkResource, unlinkResource } from "../../api";
import { PR_STATUS_STYLES } from "../../work-item-styles";
import { GitPullRequest, Loader2, Unlink } from "lucide-react";
import TaskPanelSummaryDisclosure from "../TaskPanelSummaryDisclosure";
import { type TaskPanelSummaryChip } from "../TaskPanelSummaryRow";
import { useToast } from "../../useToast";

// ── Props ────────────────────────────────────────────────────────

export interface PullRequestListProps {
  enrichedPRs: EnrichedPR[];
  rawPRs: PRRef[];
  variant?: "compact" | "card" | "summary";
  /** Task the rows are linked to. When provided, each row gets an unlink affordance. */
  taskId?: string;
  onTasksChanged?: () => void;
}

type UnlinkablePR = { repoId: string; repoName: string | null; prId: number; provider: ProviderName };

const PR_SUMMARY_STYLES: Record<string, string> = {
  active: "bg-info-surface text-info",
  completed: "bg-success/15 text-success",
  abandoned: "bg-text-muted/15 text-text-muted",
};

function sortCountEntries(a: [string, number], b: [string, number]) {
  return b[1] - a[1] || a[0].localeCompare(b[0]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Component ────────────────────────────────────────────────────

export default function PullRequestList({ enrichedPRs, rawPRs, variant = "compact", taskId, onTasksChanged }: PullRequestListProps) {
  const isCompact = variant === "compact";
  const [unlinkingKeys, setUnlinkingKeys] = useState<string[]>([]);
  const { showToast, dismissToast } = useToast();
  const canUnlink = !!taskId;

  async function handleUnlink(pr: UnlinkablePR) {
    if (!taskId) return;
    const rowKey = `${pr.repoId}-${pr.prId}`;
    setUnlinkingKeys((prev) => (prev.includes(rowKey) ? prev : [...prev, rowKey]));
    try {
      await unlinkResource(taskId, { type: "pr", repoId: pr.repoId, prId: pr.prId, provider: pr.provider });
      onTasksChanged?.();
      const toastId = showToast({
        tone: "success",
        title: `Unlinked pull request #${pr.prId}`,
        description: pr.repoName || pr.repoId,
        action: {
          label: "Undo",
          pendingLabel: "Restoring…",
          onAction: async () => {
            try {
              await linkResource(taskId, {
                type: "pr",
                repoId: pr.repoId,
                repoName: pr.repoName ?? undefined,
                prId: pr.prId,
                provider: pr.provider,
              });
              onTasksChanged?.();
              dismissToast(toastId);
            } catch (err) {
              showToast({
                tone: "error",
                title: `Could not restore pull request #${pr.prId}`,
                description: errorMessage(err),
              });
            }
          },
        },
      });
    } catch (err) {
      showToast({
        tone: "error",
        title: `Could not unlink pull request #${pr.prId}`,
        description: errorMessage(err),
      });
    } finally {
      setUnlinkingKeys((prev) => prev.filter((key) => key !== rowKey));
    }
  }

  function renderUnlinkButton(
    pr: UnlinkablePR,
    rowKey: string,
    opts: { iconSize: number; className: string },
  ) {
    const isUnlinking = unlinkingKeys.includes(rowKey);
    return (
      <button
        type="button"
        onClick={() => { void handleUnlink(pr); }}
        disabled={isUnlinking}
        title="Unlink from task"
        aria-label={`Unlink pull request #${pr.prId} from task`}
        className={`${opts.className} shrink-0 self-start text-text-muted hover:text-warning transition-colors ${
          isUnlinking
            ? "opacity-100"
            : "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        }`}
      >
        {isUnlinking
          ? <Loader2 size={opts.iconSize} className="animate-spin" />
          : <Unlink size={opts.iconSize} />}
      </button>
    );
  }

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

  if (variant === "summary") {
    if (items.length === 0) return null;

    const primaryPr = items[0];
    const hasMultiplePRs = items.length > 1;
    const statusCounts = new Map<string, number>();

    for (const pr of items) {
      if (pr.status) statusCounts.set(pr.status, (statusCounts.get(pr.status) ?? 0) + 1);
    }

    const chips: TaskPanelSummaryChip[] = [...statusCounts.entries()]
      .sort(sortCountEntries)
      .slice(0, 3)
      .map(([status, count]) => ({
        label: `${count} ${PR_STATUS_STYLES[status]?.label ?? status}`,
        className: PR_SUMMARY_STYLES[status] ?? "bg-text-muted/15 text-text-muted",
      }));

    const title = items.length === 1
      ? primaryPr.title ?? `#${primaryPr.prId}`
      : `${items.length} linked pull requests`;

    const subtitle = items.length === 1
      ? [primaryPr.repoName || primaryPr.repoId, `#${primaryPr.prId}`].join(" · ")
      : [
          items.slice(0, 2).map((pr) => `#${pr.prId}`).join(" · "),
          items.length > 2 ? `+${items.length - 2} more` : undefined,
        ]
          .filter(Boolean)
          .join(" · ");

    const singleUrl = !hasMultiplePRs && primaryPr.url && primaryPr.url !== "#" ? primaryPr.url : null;
    // A single PR with a URL opens that URL instead of expanding, so the inline
    // rows (and their unlink buttons) are unreachable — surface one in the row itself.
    const singleRowKey = `${primaryPr.repoId}-${primaryPr.prId}`;
    const showTrailingUnlink = canUnlink && items.length === 1 && !!singleUrl;

    return (
      <TaskPanelSummaryDisclosure
        label="Pull requests"
        icon={<GitPullRequest size={14} />}
        title={title}
        subtitle={subtitle || undefined}
        chips={chips}
        itemCount={items.length}
        taskId={taskId}
        disclosureId="pull-requests"
        onOpenSingle={singleUrl ? () => window.open(singleUrl, "_blank", "noopener") : undefined}
        expandWhenSingle={!singleUrl}
        trailing={showTrailingUnlink
          ? renderUnlinkButton(primaryPr, singleRowKey, { iconSize: 14, className: "p-0.5" })
          : undefined}
      >
        <PullRequestList
          enrichedPRs={enrichedPRs}
          rawPRs={rawPRs}
          variant="compact"
          taskId={taskId}
          onTasksChanged={onTasksChanged}
        />
      </TaskPanelSummaryDisclosure>
    );
  }

  return (
    <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
      {items.map((pr) => {
        const statusInfo = PR_STATUS_STYLES[pr.status ?? ""];
        const realUrl = pr.url && pr.url !== "#" ? pr.url : null;
        const rowClass = isCompact
          ? "block px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
          : "block px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors";
        const inner = (
          <>
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
                  pr.status === "active" ? "bg-info-surface text-info" :
                  pr.status === "completed" ? "bg-success/15 text-success" :
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
          </>
        );
        const rowKey = `${pr.repoId}-${pr.prId}`;
        const row = realUrl ? (
          <a
            key={rowKey}
            href={realUrl}
            target="_blank"
            rel="noopener"
            className={canUnlink ? `${rowClass} flex-1 min-w-0` : rowClass}
          >
            {inner}
          </a>
        ) : (
          <div
            key={rowKey}
            className={canUnlink ? `${rowClass} flex-1 min-w-0` : rowClass}
          >
            {inner}
          </div>
        );
        if (!canUnlink) return row;
        return (
          <div key={rowKey} className="group flex items-start gap-1">
            {row}
            {renderUnlinkButton(pr, rowKey, {
              iconSize: isCompact ? 12 : 14,
              className: isCompact ? "mt-1 p-0.5" : "mt-2 p-1",
            })}
          </div>
        );
      })}
    </div>
  );
}
