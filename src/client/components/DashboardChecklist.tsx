import { ArrowUpDown, Check, CheckSquare, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { GROUP_COLOR_DOT } from "../group-colors";
import type { DashboardChecklistState } from "../hooks/useDashboardChecklist";
import ChecklistItemRow from "./ChecklistItemRow";
import EmptyState from "./shared/EmptyState";
import { UI } from "./shared/design-system";
import { SORT_LABELS, type ChecklistSort } from "./dashboard-checklist-helpers";

interface DashboardChecklistProps {
  active: boolean;
  checklist: DashboardChecklistState;
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
}

export default function DashboardChecklist({
  active,
  checklist,
  onSelectTask,
}: DashboardChecklistProps) {
  if (!active) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className={UI.text.sectionTitle}>
          <CheckSquare size={14} />
          Open Checklist
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
                className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${
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
            placeholder="Add a checklist item..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-faint outline-none"
          />
        </div>
      </form>

      {checklist.localOpenChecklistItems.length === 0 && checklist.localCompletedChecklistItems.length === 0 ? (
        <EmptyState
          message="No checklist items yet"
          sub="Add one above or from within a task"
        />
      ) : (
        <>
          {checklist.localOpenChecklistItems.length > 0 && checklist.checklistSort === "task" ? (
            <div className="space-y-2">
              {checklist.checklistGroups.map((group) => {
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
                        {group.taskTitle ?? "Global Checklist"}
                      </span>
                      <span className="text-text-faint text-xs ml-auto shrink-0">{visibleCount}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="divide-y divide-border border-t border-border">
                        {group.checklistItems.map((checklistItem) => (
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
              {checklist.sortedOpenChecklistItems.map((checklistItem) => (
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
              <div className="text-sm text-success">✓ All done!</div>
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
        </>
      )}
    </section>
  );
}
