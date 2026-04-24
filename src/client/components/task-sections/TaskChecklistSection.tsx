import { type ReactNode } from "react";
import type { ChecklistItem } from "../../api";
import ChecklistItemRow from "../ChecklistItemRow";
import CollapsibleCompleted from "../shared/CollapsibleCompleted";
import { Plus } from "lucide-react";

// ── Props ────────────────────────────────────────────────────────

export interface TaskChecklistSectionProps {
  checklistItems: ChecklistItem[];
  newChecklistItemText: string;
  onNewChecklistItemTextChange: (text: string) => void;
  onCreateChecklistItem: (text: string) => Promise<void>;
  onChecklistItemUpdate: (checklistItem: ChecklistItem) => void;
  onChecklistItemDelete: (id: string) => void;
  variant?: "panel" | "card";
  highlightId?: string | null;
}

// ── Component ────────────────────────────────────────────────────

export default function TaskChecklistSection({
  checklistItems,
  newChecklistItemText,
  onNewChecklistItemTextChange,
  onCreateChecklistItem,
  onChecklistItemUpdate,
  onChecklistItemDelete,
  variant = "panel",
  highlightId,
}: TaskChecklistSectionProps) {
  const openChecklistItems = checklistItems.filter((t) => !t.done);
  const completedChecklistItems = checklistItems.filter((t) => t.done);
  const isCard = variant === "card";

  return (
    <>
      {isCard ? (
        <div className="space-y-1">
          {openChecklistItems.map((checklistItem) => (
            <ChecklistItemRow
              key={checklistItem.id}
              variant="card"
              checklistItem={checklistItem}
              onUpdate={onChecklistItemUpdate}
              onDelete={() => onChecklistItemDelete(checklistItem.id)}
            />
          ))}
          {completedChecklistItems.length > 0 && (
            <CollapsibleCompleted count={completedChecklistItems.length}>
              <div className="pt-1 space-y-1">
                {completedChecklistItems.map((checklistItem) => (
                  <ChecklistItemRow
                    key={checklistItem.id}
                    variant="card"
                    checklistItem={checklistItem}
                    onUpdate={onChecklistItemUpdate}
                    onDelete={() => onChecklistItemDelete(checklistItem.id)}
                  />
                ))}
              </div>
            </CollapsibleCompleted>
          )}
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
          {openChecklistItems.length > 0 && (
            <div className="space-y-0">
              {openChecklistItems.map((checklistItem) => (
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
          {completedChecklistItems.length > 0 && (
            <CollapsibleCompleted count={completedChecklistItems.length}>
              <div className="space-y-0">
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
          <div className="px-3 py-1">
            <input
              className="w-full text-xs bg-transparent border-none outline-none text-text-secondary placeholder:text-text-faint"
              placeholder="+ Add item…"
              value={newChecklistItemText}
              onChange={(e) => onNewChecklistItemTextChange(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && newChecklistItemText.trim()) {
                  onNewChecklistItemTextChange("");
                  await onCreateChecklistItem(newChecklistItemText.trim());
                }
              }}
            />
          </div>
        </>
      )}
    </>
  );
}
