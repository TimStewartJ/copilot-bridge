import { useState, useEffect, useRef } from "react";
import type { Task } from "../api";
import { X } from "lucide-react";
import TaskKindBadge from "./TaskKindBadge";
import { useModalDialog } from "./shared/useModalDialog";
import { DS, cx } from "../design/tokens";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-info-surface text-info",
  done: "bg-success/15 text-success",
  archived: "bg-text-muted/15 text-text-muted",
};

interface TaskPickerDialogProps {
  tasks: Task[];
  onSelect: (taskId: string) => void;
  onClose: () => void;
}

export default function TaskPickerDialog({
  tasks,
  onSelect,
  onClose,
}: TaskPickerDialogProps) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pickable = tasks.filter((t) => t.status === "active");

  const filtered = pickable.filter(
    (t) =>
      !search || t.title.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        {...dialogProps}
        className={cx(DS.surface.dialog, "w-full max-w-[400px] mx-4 max-h-[60vh] flex flex-col")}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 id={titleId} className="font-medium text-sm">Link to Task</h3>
          <button
            onClick={onClose}
            className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-border">
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tasks…"
            className={cx(DS.field.input, DS.field.inputSize.md, DS.focus)}
          />
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="text-xs text-text-faint px-3 py-4 text-center">
              {pickable.length === 0
                ? "No active tasks"
                : "No tasks match your search"}
            </div>
          ) : (
            filtered.map((task) => (
              <button
                key={task.id}
                onClick={() => onSelect(task.id)}
                className={cx(DS.row.base, DS.row.interactive, "w-full text-left hover:bg-bg-hover", DS.row.touch)}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate flex-1">
                    {task.title}
                  </span>
                  <TaskKindBadge kind={task.kind} iconOnly className="shrink-0" />
                  <span
                    className={cx(DS.badge.base, "shrink-0", STATUS_COLORS[task.status] ?? "")}
                  >
                    {task.status}
                  </span>
                </div>
                <div className="text-[10px] text-text-faint mt-0.5">
                  {task.sessionIds.length} session{task.sessionIds.length !== 1 ? "s" : ""}
                  {task.workItems.length > 0 &&
                    ` · ${task.workItems.length} work item${task.workItems.length !== 1 ? "s" : ""}`}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
