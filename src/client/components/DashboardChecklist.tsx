import { useState } from "react";
import { ArrowUpDown, Check, CheckSquare, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { GROUP_COLOR_DOT } from "../group-colors";
import type { DashboardChecklistState } from "../hooks/useDashboardChecklist";
import ChecklistItemRow from "./ChecklistItemRow";
import EmptyState from "./shared/EmptyState";
import { UI } from "./shared/design-system";
import { SORT_LABELS, type ChecklistSort } from "./dashboard-checklist-helpers";
import { getDashboardPanelId, getDashboardTabId } from "../lib/dashboard-routes";

interface DashboardChecklistProps {
  active: boolean;
  checklist: DashboardChecklistState;
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  embedded?: boolean;
  heading?: string;
  bounded?: boolean;
  onInspectFocusObject?: (id: string) => void;
}

export default function DashboardChecklist({
  active,
  checklist,
  onSelectTask,
  embedded = false,
  heading = "Open Checklist",
  bounded = false,
  onInspectFocusObject,
}: DashboardChecklistProps) {
  const [showAllActions, setShowAllActions] = useState(false);
  const limited = bounded && !showAllActions;
  const visibleItems = limited ? checklist.sortedOpenChecklistItems.slice(0, 6) : checklist.sortedOpenChecklistItems;
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  if (!active) return null;

  return (
    <section
      id={embedded ? undefined : getDashboardPanelId("focus")}
      role={embedded ? undefined : "tabpanel"}
      aria-labelledby={embedded ? undefined : getDashboardTabId("focus")}
      tabIndex={embedded ? undefined : 0}
      className="space-y-3"
    >
      <div className="flex items-center justify-between">
        <h2 className={UI.text.sectionTitle}>
          <CheckSquare size={14} />
          {heading}
          {checklist.visibleOpenChecklistItems.length > 0 && (
            <span className="text-text-faint font-normal">
              ({checklist.visibleOpenChecklistItems.length})
            </span>
          )}
        </h2>
        {checklist.localOpenChecklistItems.length > 1 && (
          <div className="flex items-center gap-1">
            <ArrowUpDown size={11} className="text-text-faint" />
            {(Object.keys(SORT_LABELS) as ChecklistSort[]).map((sort) => (
              <button
                key={sort}
                onClick={() => checklist.handleSortChange(sort)}
                className={`min-h-11 text-[11px] px-1.5 py-0.5 rounded transition-colors ${
                  checklist.checklistSort === sort
                    ? `${UI.chip.selected} font-medium`
                    : "text-text-faint hover:text-text-secondary"
                }`}
              >
                {SORT_LABELS[sort]}
              </button>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={checklist.handleAddChecklistItem}>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-surface border border-border focus-within:border-accent transition-colors">
          <Plus size={14} className="text-text-faint shrink-0" />
          <input
            type="text"
            value={checklist.newChecklistItemText}
            onChange={(event) => checklist.setNewChecklistItemText(event.target.value)}
            placeholder={heading === "Actions" ? "Add a Global Action..." : "Add a checklist item..."}
            aria-label={heading === "Actions" ? "Add a Global Action" : "Add a checklist item"}
            className="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-faint outline-none"
          />
        </div>
      </form>

      <div
        role={bounded ? "region" : undefined}
        aria-label={bounded ? `${heading} list` : undefined}
        tabIndex={bounded ? 0 : undefined}
        className={bounded
          ? "outline-none xl:max-h-[36rem] xl:overflow-y-auto xl:overscroll-contain xl:pr-1 xl:focus-visible:ring-2 xl:focus-visible:ring-accent-border"
          : undefined}
      >
        {checklist.localOpenChecklistItems.length === 0 && checklist.localCompletedChecklistItems.length === 0 ? (
          <EmptyState
            message={heading === "Actions" ? "No actions yet" : "No checklist items yet"}
            sub={heading === "Actions" ? "Add one above or promote a decision into an action" : "Add one above or from within a task"}
          />
        ) : (
          <div className="space-y-3">
            {checklist.localOpenChecklistItems.length > 0 && checklist.checklistSort === "task" ? (
              <div className="space-y-2">
                {checklist.checklistGroups.map((group) => {
                  const groupItems = group.checklistItems.filter((item) => visibleIds.has(item.id));
                  if (groupItems.length === 0) return null;
                  const isCollapsed = checklist.collapsedGroups.has(group.key);
                  const visibleCount = group.checklistItems.filter((item) => !checklist.exitingIds.has(item.id)).length;
                  return (
                    <div key={group.key} className="bg-bg-surface border border-border rounded-lg overflow-hidden">
                      <button
                        onClick={() => checklist.toggleGroupCollapse(group.key)}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-bg-hover transition-colors"
                      >
                        {isCollapsed
                          ? <ChevronRight size={14} className="text-text-faint shrink-0" />
                          : <ChevronDown size={14} className="text-text-faint shrink-0" />
                        }
                        {group.taskGroupColor && (
                          <span className={`w-2 h-2 rounded-full shrink-0 ${GROUP_COLOR_DOT[group.taskGroupColor] ?? ""}`} />
                        )}
                        <span className="font-medium text-text-secondary truncate">
                          {group.taskTitle ?? (heading === "Actions" ? "Global Actions" : "Global Checklist")}
                        </span>
                        <span className="text-text-faint text-xs ml-auto shrink-0">{visibleCount}</span>
                      </button>
                      {!isCollapsed && (
                        <div className="divide-y divide-border border-t border-border">
                          {groupItems.map((checklistItem) => (
                            <div
                              key={checklistItem.id}
                              className={checklist.exitingIds.has(checklistItem.id) ? "animate-checklist-check" : ""}
                              onAnimationEnd={() => {
                                if (checklist.exitingIds.has(checklistItem.id)) checklist.moveOpenItemToCompleted(checklistItem);
                              }}
                            >
                              <ChecklistItemRow
                                variant="dashboard"
                                checklistItem={checklistItem}
                                onInspectFocusObject={onInspectFocusObject}
                                hideTaskPill
                                onSelectTask={checklistItem.taskId ? () => onSelectTask(checklistItem.taskId!, { checklistItemId: checklistItem.id }) : undefined}
                                onToggle={() => { void checklist.markOpenItemDone(checklistItem); }}
                                onDeadlineChange={(deadline) => checklist.updateOpenItem({ id: checklistItem.id, deadline: deadline ?? undefined })}
                                onUpdate={checklist.updateOpenItem}
                                onDelete={() => checklist.removeOpenItem(checklistItem.id)}
                                canDelete={!checklistItem.taskId}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : checklist.localOpenChecklistItems.length > 0 ? (
              <div className="bg-bg-surface border border-border rounded-lg divide-y divide-border">
                {visibleItems.map((checklistItem) => (
                  <div
                    key={checklistItem.id}
                    className={checklist.exitingIds.has(checklistItem.id) ? "animate-checklist-check" : ""}
                    onAnimationEnd={() => {
                      if (checklist.exitingIds.has(checklistItem.id)) checklist.moveOpenItemToCompleted(checklistItem);
                    }}
                  >
                    <ChecklistItemRow
                      variant="dashboard"
                      checklistItem={checklistItem}
                      onInspectFocusObject={onInspectFocusObject}
                      onSelectTask={checklistItem.taskId ? () => onSelectTask(checklistItem.taskId!, { checklistItemId: checklistItem.id }) : undefined}
                      onToggle={() => { void checklist.markOpenItemDone(checklistItem); }}
                      onDeadlineChange={(deadline) => checklist.updateOpenItem({ id: checklistItem.id, deadline: deadline ?? undefined })}
                      onUpdate={checklist.updateOpenItem}
                      onDelete={() => checklist.removeOpenItem(checklistItem.id)}
                      canDelete={!checklistItem.taskId}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {checklist.localOpenChecklistItems.length === 0 && checklist.localCompletedChecklistItems.length > 0 && (
              <div className="text-center py-6 px-4 rounded-md bg-bg-surface border border-border">
                <div className="text-sm text-text-muted">{heading === "Actions" ? "No open Actions in this view. Source concerns may still be open." : "No open checklist items."}</div>
              </div>
            )}

            {checklist.localCompletedChecklistItems.length > 0 && (
              <>
                <button
                  onClick={() => checklist.setShowCompleted((value) => !value)}
                  className={UI.text.sectionTitle}
                >
                  {checklist.showCompleted ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Check size={14} />
                  Completed
                  <span className="text-text-faint font-normal">({checklist.localCompletedChecklistItems.length})</span>
                </button>
                {checklist.showCompleted && (
                  <div className="bg-bg-surface border border-border rounded-lg divide-y divide-border">
                    {checklist.localCompletedChecklistItems.map((checklistItem) => (
                      <ChecklistItemRow
                        key={checklistItem.id}
                        variant="dashboard"
                        checklistItem={checklistItem}
                        onInspectFocusObject={onInspectFocusObject}
                        onSelectTask={checklistItem.taskId ? () => onSelectTask(checklistItem.taskId!, { checklistItemId: checklistItem.id }) : undefined}
                        onToggle={() => { void checklist.restoreCompletedItem(checklistItem); }}
                        onUpdate={checklist.updateCompletedItem}
                        onDelete={() => checklist.removeCompletedItem(checklistItem.id)}
                        canDelete={!checklistItem.taskId}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {bounded && checklist.sortedOpenChecklistItems.length > 6 && (
        <button type="button" aria-expanded={showAllActions} className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => setShowAllActions((value) => !value)}>
          {showAllActions ? "Show fewer Actions" : `Show all ${checklist.sortedOpenChecklistItems.length} Actions`}
        </button>
      )}
      {bounded && showAllActions && checklist.visibleOpenChecklistItems.length > 6 && (
        <div className="hidden items-center justify-between gap-3 border-t border-border/70 pt-3 text-[11px] text-text-faint xl:flex">
          <span>Scroll within Actions to review the full list.</span>
          <span>{checklist.visibleOpenChecklistItems.length} open</span>
        </div>
      )}
    </section>
  );
}
