import { ClipboardList, GitPullRequest } from "lucide-react";
import type { EnrichedPR, EnrichedWorkItem } from "../api";
import { PR_STATUS_STYLES, WI_STATE_STYLES, WI_TYPE_ICONS } from "../work-item-styles";
import { UI } from "./shared/design-system";

export function WorkItemPreviewCard({ item }: { item: EnrichedWorkItem }) {
  const typeInfo = WI_TYPE_ICONS[item.type ?? ""];
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener"
      className={`${UI.surface.cardInset} block border-l-2 border-l-error px-3 py-3 transition-colors hover:bg-bg-hover`}
      data-work-reference-kind="workItem"
    >
      <span className="flex items-center gap-2">
        <span className={typeInfo?.color ?? "text-text-muted"}>
          {typeInfo?.icon ?? <ClipboardList size={14} />}
        </span>
        <span className="text-xs font-semibold text-accent">#{item.id}</span>
        {item.state && (
          <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${WI_STATE_STYLES[item.state] ?? UI.chip.muted}`}>
            {item.state}
          </span>
        )}
      </span>
      <span className="mt-2 block text-sm font-medium leading-snug text-text-primary">
        {item.title ?? `ADO work item ${item.id}`}
      </span>
      <span className="mt-2 block space-y-0.5 text-[10px] text-text-faint">
        {(item.type || item.assignedTo) && (
          <span className="block">{[item.type, item.assignedTo].filter(Boolean).join(" - ")}</span>
        )}
        {item.areaPath && <span className="block truncate">{item.areaPath}</span>}
      </span>
    </a>
  );
}

export function PullRequestPreviewCard({ pullRequest }: { pullRequest: EnrichedPR }) {
  const statusInfo = PR_STATUS_STYLES[pullRequest.status ?? ""];
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noopener"
      className={`${UI.surface.cardInset} block border-l-2 border-l-info px-3 py-3 transition-colors hover:bg-bg-hover`}
      data-work-reference-kind="pullRequest"
    >
      <span className="flex items-center gap-2">
        {statusInfo
          ? <span className={`h-2 w-2 shrink-0 rounded-full ${statusInfo.dot}`} />
          : <GitPullRequest size={13} className="text-text-muted" />}
        <span className="text-xs font-semibold text-accent">PR #{pullRequest.prId}</span>
        {statusInfo && (
          <span className="ml-auto text-[10px] text-text-muted">{statusInfo.label}</span>
        )}
      </span>
      <span className="mt-2 block text-sm font-medium leading-snug text-text-primary">
        {pullRequest.title ?? `Pull request ${pullRequest.prId}`}
      </span>
      <span className="mt-2 block text-[10px] text-text-faint">
        {pullRequest.repoName ?? pullRequest.repoId}
      </span>
    </a>
  );
}
