import type { EnrichedWorkItem, WorkItemRef } from "../../api";
import { WI_TYPE_ICONS, WI_STATE_STYLES } from "../../work-item-styles";
import { ClipboardList } from "lucide-react";
import TaskPanelSummaryRow, { type TaskPanelSummaryChip } from "../TaskPanelSummaryRow";

// ── Props ────────────────────────────────────────────────────────

export interface WorkItemListProps {
  enrichedWIs: EnrichedWorkItem[];
  rawWIs: WorkItemRef[];
  variant?: "compact" | "card" | "summary";
  onOpenSummary?: () => void;
}

function sortCountEntries(a: [string, number], b: [string, number]) {
  return b[1] - a[1] || a[0].localeCompare(b[0]);
}

// ── Component ────────────────────────────────────────────────────

export default function WorkItemList({ enrichedWIs, rawWIs, variant = "compact", onOpenSummary }: WorkItemListProps) {
  const isCompact = variant === "compact";
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

    return (
      <TaskPanelSummaryRow
        label="Work items"
        icon={<ClipboardList size={14} />}
        title={title}
        subtitle={subtitle || undefined}
        chips={chips}
        onClick={onOpenSummary}
      />
    );
  }

  return (
    <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
      {items.map((wi) => {
        const typeInfo = WI_TYPE_ICONS[wi.type ?? ""];
        return (
          <a
            key={`${wi.provider}-${wi.id}`}
            href={wi.url}
            target="_blank"
            rel="noopener"
            className={
              isCompact
                ? "block px-3 py-1.5 text-xs text-accent hover:text-accent-hover hover:bg-bg-hover rounded-md transition-colors"
                : "block px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
            }
          >
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
          </a>
        );
      })}
    </div>
  );
}
