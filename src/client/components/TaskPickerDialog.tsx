import { useState, useEffect, useRef } from "react";
import type { Task } from "../api";
import { X } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-success/15 text-success",
  paused: "bg-warning/15 text-warning",
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const pickable = tasks.filter(
    (t) => t.status === "active" || t.status === "paused",
  );

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
      <div className="bg-bg-secondary border border-border rounded-md w-full max-w-[400px] mx-4 max-h-[60vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-medium text-sm">Link to Task</h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-secondary"
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
            className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-sm focus:outline-none focus:border-accent"
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
                className="w-full text-left px-3 py-2.5 rounded-md text-sm hover:bg-bg-hover transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate flex-1">
                    {task.title}
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[task.status] ?? ""}`}
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
