import { useEffect, useRef, useState } from "react";
import type { ChecklistItem } from "../../api";
import { shouldSurfaceReadyToCompleteCue } from "../../task-completion-helpers";
import { getTaskPanelChecklistPreview } from "../../task-panel-preview";
import ChecklistItemRow from "../ChecklistItemRow";
import CollapsibleCompleted from "../shared/CollapsibleCompleted";
import { CheckCircle2, Plus } from "lucide-react";

// ── Props ────────────────────────────────────────────────────────

export interface TaskChecklistSectionProps {
  taskId: string;
  checklistItems: ChecklistItem[];
  newChecklistItemText: string;
  onNewChecklistItemTextChange: (text: string) => void;
  onCreateChecklistItem: (text: string) => Promise<void>;
  onChecklistItemUpdate: (checklistItem: ChecklistItem) => void;
  onChecklistItemDelete: (id: string) => void;
  variant?: "panel" | "card";
  highlightId?: string | null;
  isReadyToComplete?: boolean;
}

// ── Component ────────────────────────────────────────────────────

export default function TaskChecklistSection({
  taskId,
  checklistItems,
  newChecklistItemText,
  onNewChecklistItemTextChange,
  onCreateChecklistItem,
  onChecklistItemUpdate,
  onChecklistItemDelete,
  variant = "panel",
  highlightId,
  isReadyToComplete = false,
}: TaskChecklistSectionProps) {
  const openChecklistItems = checklistItems.filter((t) => !t.done);
  const completedChecklistItems = checklistItems.filter((t) => t.done);
  const isCard = variant === "card";
  const panelPreview = getTaskPanelChecklistPreview(checklistItems, { highlightId });
  const [showAllOpen, setShowAllOpen] = useState(false);
  const hasHighlightedCompletedItem = completedChecklistItems.some((item) => item.id === highlightId);
  const panelOpenItems = showAllOpen ? openChecklistItems : panelPreview.openPreviewItems;
  const shouldShowOpenExpansion = panelPreview.hiddenOpenCount > 0;
  const [showReadyCue, setShowReadyCue] = useState(false);
  const previousOpenChecklistItemsRef = useRef<number | null>(null);

  useEffect(() => {
    previousOpenChecklistItemsRef.current = null;
    setShowReadyCue(false);
    setShowAllOpen(false);
  }, [taskId]);

  useEffect(() => {
    const previousOpenChecklistItems = previousOpenChecklistItemsRef.current;
    const nextOpenChecklistItems = openChecklistItems.length;

    if (shouldSurfaceReadyToCompleteCue({
      previousOpenChecklistItems,
      nextOpenChecklistItems,
      isReadyToComplete,
    })) {
      setShowReadyCue(true);
    } else if (nextOpenChecklistItems > 0 || !isReadyToComplete) {
      setShowReadyCue(false);
    }

    previousOpenChecklistItemsRef.current = nextOpenChecklistItems;
  }, [isReadyToComplete, openChecklistItems.length]);

  useEffect(() => {
    if (!showReadyCue) return;
    const timer = window.setTimeout(() => setShowReadyCue(false), 5000);
    return () => window.clearTimeout(timer);
  }, [showReadyCue]);

  const readyCue = showReadyCue && (
    <div className={`mx-3 rounded-md border border-success/25 bg-success/8 px-3 py-2 text-xs text-success ${
      isCard ? "mb-2" : "mb-1.5"
    }`}>
      <div className="flex items-start gap-2">
        <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
        <span>Ready to complete — the checklist is finished. Use Complete task when you&apos;re ready.</span>
      </div>
    </div>
  );

  return (
    <>
      {isCard ? (
        <div className="space-y-1">
          {openChecklistItems.map((checklistItem) => (
            <ChecklistItemRow
              key={checklistItem.id}
              variant="card"
              checklistItem={checklistItem}
              highlight={checklistItem.id === highlightId}
              onUpdate={onChecklistItemUpdate}
              onDelete={() => onChecklistItemDelete(checklistItem.id)}
            />
          ))}
          {completedChecklistItems.length > 0 && (
            <CollapsibleCompleted
              count={completedChecklistItems.length}
              forceOpen={hasHighlightedCompletedItem}
            >
              <div className="pt-1 space-y-1">
                {completedChecklistItems.map((checklistItem) => (
                  <ChecklistItemRow
                    key={checklistItem.id}
                    variant="card"
                    checklistItem={checklistItem}
                    highlight={checklistItem.id === highlightId}
                    onUpdate={onChecklistItemUpdate}
                    onDelete={() => onChecklistItemDelete(checklistItem.id)}
                  />
                ))}
              </div>
            </CollapsibleCompleted>
          )}
          {readyCue}
          <form
            className="flex items-center gap-2 px-3 py-1.5"
            onSubmit={async (e) => {
              e.preventDefault();
              const text = newChecklistItemText.trim();
              if (!text) return;
              onNewChecklistItemTextChange("");
              await onCreateChecklistItem(text);
            }}
          >
            <Plus size={14} className="text-text-faint shrink-0" />
            <input
              type="text"
              value={newChecklistItemText}
              onChange={(e) => onNewChecklistItemTextChange(e.target.value)}
              placeholder="Add a checklist item..."
              className="flex-1 text-sm bg-transparent border-none outline-none text-text-primary placeholder:text-text-faint"
            />
          </form>
        </div>
      ) : (
        <>
          {panelOpenItems.length > 0 && (
            <div className="space-y-0">
              {panelOpenItems.map((checklistItem) => (
                <ChecklistItemRow
                  key={checklistItem.id}
                  variant="panel"
                  checklistItem={checklistItem}
                  highlight={checklistItem.id === highlightId}
                  onUpdate={onChecklistItemUpdate}
                  onDelete={() => onChecklistItemDelete(checklistItem.id)}
                />
              ))}
            </div>
          )}
          {readyCue}
          <div className="px-3 py-1">
            <input
              className="w-full text-xs bg-transparent border-none outline-none text-text-secondary placeholder:text-text-faint"
              placeholder="+ Add item…"
              value={newChecklistItemText}
              onChange={(e) => onNewChecklistItemTextChange(e.target.value)}
              onKeyDown={async (e) => {
                const text = newChecklistItemText.trim();
                if (e.key === "Enter" && text) {
                  onNewChecklistItemTextChange("");
                  await onCreateChecklistItem(text);
                  setShowAllOpen(true);
                }
              }}
            />
          </div>
          {shouldShowOpenExpansion && (
            <button
              onClick={() => setShowAllOpen((value) => !value)}
              className="px-3 pb-1 text-[11px] text-accent hover:text-accent-hover transition-colors"
            >
              {showAllOpen ? "Show fewer open items" : "View full checklist"}
              <span className="text-text-faint ml-1">
                · {showAllOpen ? `${openChecklistItems.length} open` : `${panelPreview.hiddenOpenCount} more open`}
              </span>
            </button>
          )}
          {completedChecklistItems.length > 0 && (
            <CollapsibleCompleted
              key={`panel-done-${taskId}`}
              count={completedChecklistItems.length}
              label="done"
              forceOpen={hasHighlightedCompletedItem}
            >
              <div className="pt-1 space-y-0">
                {completedChecklistItems.map((checklistItem) => (
                  <ChecklistItemRow
                    key={checklistItem.id}
                    variant="panel"
                    checklistItem={checklistItem}
                    highlight={checklistItem.id === highlightId}
                    onUpdate={onChecklistItemUpdate}
                    onDelete={() => onChecklistItemDelete(checklistItem.id)}
                  />
                ))}
              </div>
            </CollapsibleCompleted>
          )}
        </>
      )}
    </>
  );
}
