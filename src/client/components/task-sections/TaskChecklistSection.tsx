import { useEffect, useMemo, useRef, useState } from "react";
import type { ChecklistItem } from "../../api";
import { shouldSurfaceReadyToCompleteCue } from "../../task-completion-helpers";
import { getTaskPanelChecklistPreview } from "../../task-panel-preview";
import ChecklistItemRow from "../ChecklistItemRow";
import CollapsibleCompleted from "../shared/CollapsibleCompleted";
import { CheckCircle2, Flag, Plus } from "lucide-react";
import { extractWhen } from "../../../shared/typed-date";
import { DS, cx } from "../../design/tokens";

/**
 * A date said at the end of a new item ("Renew passport by fri") becomes its deadline. Only a date:
 * a deadline has no time, so a phrase with one stays in the text rather than lose the time.
 */
export function readDeadlinePhrase(text: string, now = new Date()): { text: string; deadline: string; phrase: string } | null {
  const found = extractWhen(text.trim(), now);
  if (!found || found.when.time) return null;
  return { text: found.rest, deadline: found.when.date, phrase: found.phrase };
}

function formatDeadline(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// ── Props ────────────────────────────────────────────────────────

export interface TaskChecklistSectionProps {
  taskId: string;
  checklistItems: ChecklistItem[];
  newChecklistItemText: string;
  onNewChecklistItemTextChange: (text: string) => void;
  onCreateChecklistItem: (text: string, deadline?: string) => Promise<void>;
  onChecklistItemUpdate: (checklistItem: ChecklistItem) => void;
  onChecklistItemDelete: (id: string) => void;
  variant?: "panel" | "card";
  highlightId?: string | null;
  isReadyToComplete?: boolean;
  /**
   * Panel only: whether the add field shows. The panel hides it once nothing is open and reveals
   * it from the section's Add button.
   */
  showComposer?: boolean;
  onComposerDone?: () => void;
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
  showComposer = true,
  onComposerDone,
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
  // The text the reader chose to keep as typed; a new edit reads it again.
  const [keptAsText, setKeptAsText] = useState<string | null>(null);
  const deadlinePhrase = useMemo(() => newChecklistItemText.trim() && keptAsText !== newChecklistItemText
    ? readDeadlinePhrase(newChecklistItemText) : null, [newChecklistItemText, keptAsText]);
  const submitNewItem = async () => {
    const text = newChecklistItemText.trim();
    if (!text) return false;
    onNewChecklistItemTextChange("");
    setKeptAsText(null);
    if (deadlinePhrase) await onCreateChecklistItem(deadlinePhrase.text, deadlinePhrase.deadline);
    else await onCreateChecklistItem(text);
    return true;
  };
  const deadlineHint = deadlinePhrase && (
    <div className={cx(DS.text.meta, "flex items-center gap-1.5", isCard ? "px-3 pb-1" : "px-3 pb-1")}>
      <Flag size={11} className="text-warning" aria-hidden="true" />
      <span>Due {formatDeadline(deadlinePhrase.deadline)}</span>
      <button type="button" className={cx(DS.focus, "text-text-secondary hover:text-text-primary")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setKeptAsText(newChecklistItemText)}>Keep as text</button>
    </div>
  );
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
    <div role="status" className={`flex items-start gap-2 text-xs leading-relaxed text-text-secondary ${isCard ? "mx-3 mb-2" : "mb-1.5"}`}>
      <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
      <span>Checklist finished. Ready to complete.</span>
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
              await submitNewItem();
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
          {deadlineHint}
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
          {showComposer && (
            <div className="px-3 py-1">
              <input
                aria-label="Add checklist item"
                autoFocus={openChecklistItems.length === 0}
                className="w-full text-[13px] bg-transparent border-none outline-none text-text-secondary placeholder:text-text-faint"
                placeholder="+ Add item…"
                value={newChecklistItemText}
                onChange={(e) => onNewChecklistItemTextChange(e.target.value)}
                onBlur={() => {
                  if (!newChecklistItemText.trim()) onComposerDone?.();
                }}
                onKeyDown={async (e) => {
                  const text = newChecklistItemText.trim();
                  if (e.key === "Escape" && !text) {
                    onComposerDone?.();
                    return;
                  }
                  if (e.key === "Enter" && text) {
                    await submitNewItem();
                    setShowAllOpen(true);
                  }
                }}
              />
            </div>
          )}
          {showComposer && deadlineHint}
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
