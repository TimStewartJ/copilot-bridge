import { useState } from "react";
import type { EnrichedWorkItem, ProviderName, WorkItemRef } from "../../api";
import { linkResource, unlinkResource } from "../../api";
import { WI_TYPE_ICONS, WI_STATE_STYLES } from "../../work-item-styles";
import { ClipboardList, Loader2, Unlink } from "lucide-react";
import TaskPanelSummaryDisclosure from "../TaskPanelSummaryDisclosure";
import { type TaskPanelSummaryChip } from "../TaskPanelSummaryRow";
import { useToast } from "../../useToast";

// ── Props ────────────────────────────────────────────────────────

export interface WorkItemListProps {
  enrichedWIs: EnrichedWorkItem[];
  rawWIs: WorkItemRef[];
  variant?: "compact" | "card" | "summary";
  /** Task the rows are linked to. When provided, each row gets an unlink affordance. */
  taskId?: string;
  onTasksChanged?: () => void;
}

type UnlinkableWorkItem = { id: string; provider: ProviderName; title: string | null };

function sortCountEntries(a: [string, number], b: [string, number]) {
  return b[1] - a[1] || a[0].localeCompare(b[0]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Component ────────────────────────────────────────────────────

export default function WorkItemList({ enrichedWIs, rawWIs, variant = "compact", taskId, onTasksChanged }: WorkItemListProps) {
  const isCompact = variant === "compact";
  const [unlinkingKeys, setUnlinkingKeys] = useState<string[]>([]);
  const { showToast, dismissToast } = useToast();
  const canUnlink = !!taskId;

  async function handleUnlink(wi: UnlinkableWorkItem) {
    if (!taskId) return;
    const rowKey = `${wi.provider}-${wi.id}`;
    setUnlinkingKeys((prev) => (prev.includes(rowKey) ? prev : [...prev, rowKey]));
    try {
      await unlinkResource(taskId, { type: "workItem", workItemId: wi.id, provider: wi.provider });
      onTasksChanged?.();
      const toastId = showToast({
        tone: "success",
        title: `Unlinked work item ${wi.id}`,
        description: wi.title ?? undefined,
        action: {
          label: "Undo",
          pendingLabel: "Restoring…",
          onAction: async () => {
            try {
              await linkResource(taskId, { type: "workItem", workItemId: wi.id, provider: wi.provider });
              onTasksChanged?.();
              dismissToast(toastId);
            } catch (err) {
              showToast({
                tone: "error",
                title: `Could not restore work item ${wi.id}`,
                description: errorMessage(err),
              });
            }
          },
        },
      });
    } catch (err) {
      showToast({
        tone: "error",
        title: `Could not unlink work item ${wi.id}`,
        description: errorMessage(err),
      });
    } finally {
      setUnlinkingKeys((prev) => prev.filter((key) => key !== rowKey));
    }
  }

  function renderUnlinkButton(
    wi: UnlinkableWorkItem,
    rowKey: string,
    opts: { iconSize: number; className: string },
  ) {
    const isUnlinking = unlinkingKeys.includes(rowKey);
    return (
      <button
        type="button"
        onClick={() => { void handleUnlink(wi); }}
        disabled={isUnlinking}
        title="Unlink from task"
        aria-label={`Unlink work item ${wi.id} from task`}
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

  const items = enrichedWIs.length > 0
    ? enrichedWIs
    : rawWIs.map((w) => ({
        id: w.id,
        provider: w.provider,
        title: null as string | null,
        state: null as string | null,
        type: null as string | null,
        assignedTo: null as string | null,
        areaPath: null as string | null,
        url: "#",
      }));

  if (variant === "summary") {
    if (items.length === 0) return null;

    const primaryItem = items[0];
    const stateCounts = new Map<string, number>();

    for (const wi of items) {
      if (wi.state) stateCounts.set(wi.state, (stateCounts.get(wi.state) ?? 0) + 1);
    }

    const chips: TaskPanelSummaryChip[] = [...stateCounts.entries()]
      .sort(sortCountEntries)
      .slice(0, 3)
      .map(([state, count]) => ({
        label: `${count} ${state}`,
        className: WI_STATE_STYLES[state] ?? "bg-text-muted/15 text-text-muted",
      }));

    const title = items.length === 1
      ? primaryItem.title ?? primaryItem.id
      : `${items.length} linked work items`;

    const subtitle = items.length === 1
      ? [primaryItem.id, primaryItem.type, primaryItem.assignedTo ?? primaryItem.areaPath]
          .filter(Boolean)
          .join(" · ")
      : [
          items.slice(0, 2).map((wi) => wi.id).join(" · "),
          items.length > 2 ? `+${items.length - 2} more` : undefined,
        ]
          .filter(Boolean)
          .join(" · ");

    const singleUrl = primaryItem.url && primaryItem.url !== "#" ? primaryItem.url : null;
    // A single item with a URL opens that URL instead of expanding, so the inline
    // rows (and their unlink buttons) are unreachable — surface one in the row itself.
    const singleRowKey = `${primaryItem.provider}-${primaryItem.id}`;
    const showTrailingUnlink = canUnlink && items.length === 1 && !!singleUrl;

    return (
      <TaskPanelSummaryDisclosure
        label="Work items"
        icon={<ClipboardList size={14} />}
        title={title}
        subtitle={subtitle || undefined}
        chips={chips}
        itemCount={items.length}
        taskId={taskId}
        disclosureId="work-items"
        onOpenSingle={singleUrl ? () => window.open(singleUrl, "_blank", "noopener") : undefined}
        expandWhenSingle={!singleUrl}
        trailing={showTrailingUnlink
          ? renderUnlinkButton(primaryItem, singleRowKey, { iconSize: 14, className: "p-0.5" })
          : undefined}
      >
        <WorkItemList
          enrichedWIs={enrichedWIs}
          rawWIs={rawWIs}
          variant="compact"
          taskId={taskId}
          onTasksChanged={onTasksChanged}
        />
      </TaskPanelSummaryDisclosure>
    );
  }

  return (
    <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
      {items.map((wi) => {
        const typeInfo = WI_TYPE_ICONS[wi.type ?? ""];
        const realUrl = wi.url && wi.url !== "#" ? wi.url : null;
        const rowClass = isCompact
          ? "block px-3 py-1.5 text-xs text-accent hover:text-accent-hover hover:bg-bg-hover rounded-md transition-colors"
          : "block px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors";
        const inner = (
          <div className={`flex items-center ${isCompact ? "gap-1.5" : "gap-2"}`}>
            {isCompact ? (
              <span>{typeInfo?.icon ?? <ClipboardList size={12} />}</span>
            ) : (
              <span className={typeInfo?.color ?? "text-text-muted"}>
                {typeInfo?.icon ?? <ClipboardList size={14} />}
              </span>
            )}
            <span className={`font-medium ${isCompact ? "" : "text-xs text-accent"}`}>{wi.id}</span>
            {isCompact && wi.title && (
              <span className="text-text-muted truncate">{wi.title}</span>
            )}
            {!isCompact && wi.state && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${WI_STATE_STYLES[wi.state] ?? "bg-text-muted/15 text-text-muted"}`}>
                {wi.state}
              </span>
            )}
          </div>
        );
        const rowKey = `${wi.provider}-${wi.id}`;
        const details = (
          <>
            {isCompact && wi.state && (
              <div className="mt-0.5 ml-5">
                <span className={`text-[9px] px-1 py-0.5 rounded-full ${WI_STATE_STYLES[wi.state] ?? "bg-text-muted/15 text-text-muted"}`}>
                  {wi.state}
                </span>
              </div>
            )}
            {!isCompact && wi.title && (
              <div className="text-sm text-text-primary mt-1 ml-6 line-clamp-2">{wi.title}</div>
            )}
            {!isCompact && (wi.assignedTo || wi.areaPath) && (
              <div className="text-[10px] text-text-faint mt-1 ml-6 flex items-center gap-2">
                {wi.assignedTo && <span>{wi.assignedTo}</span>}
                {wi.areaPath && <span>{wi.areaPath}</span>}
              </div>
            )}
          </>
        );
        const row = realUrl ? (
          <a
            key={rowKey}
            href={realUrl}
            target="_blank"
            rel="noopener"
            className={canUnlink ? `${rowClass} flex-1 min-w-0` : rowClass}
          >
            {inner}
            {details}
          </a>
        ) : (
          <div
            key={rowKey}
            className={canUnlink ? `${rowClass} flex-1 min-w-0` : rowClass}
          >
            {inner}
            {details}
          </div>
        );
        if (!canUnlink) return row;
        return (
          <div key={rowKey} className="group flex items-start gap-1">
            {row}
            {renderUnlinkButton(wi, rowKey, {
              iconSize: isCompact ? 12 : 14,
              className: isCompact ? "mt-1 p-0.5" : "mt-2 p-1",
            })}
          </div>
        );
      })}
    </div>
  );
}
