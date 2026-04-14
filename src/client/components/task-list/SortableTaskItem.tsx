import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pin } from "lucide-react";
import { timeAgo } from "../../time";
import { TAG_COLOR_DOT as TAG_DOT } from "../../tag-colors";
import type { Task } from "../../api";
import type { TaskIndicator } from "../../hooks/useTaskIndicators";

const STATUS_TEXT: Record<Task["status"], string> = {
  active: "text-success",
  paused: "text-warning",
  done: "text-text-muted",
  archived: "text-text-faint",
};

interface SortableTaskItemProps {
  task: Task;
  isActive: boolean;
  indicator: TaskIndicator | undefined;
  isCtxTarget: boolean;
  isLongPressTarget: boolean;
  bindLongPress: (id: string, onClick: () => void) => Record<string, unknown>;
  onSelectTask: (id: string) => void;
  /** "rail" shows tag dots + status text and uses tighter padding; "list" is the mobile/simple variant */
  variant?: "rail" | "list";
}

export default function SortableTaskItem({
  task,
  isActive,
  indicator,
  isCtxTarget,
  isLongPressTarget,
  bindLongPress,
  onSelectTask,
  variant = "list",
}: SortableTaskItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const isRail = variant === "rail";

  return (
    <div ref={setNodeRef} style={style} className="group">
      <button
        {...bindLongPress(task.id, () => onSelectTask(task.id))}
        className={`relative w-full text-left px-3 ${isRail ? "py-2" : "py-2.5"} rounded-md text-sm select-none no-callout transition-all duration-150 ${
          isCtxTarget
            ? "bg-bg-hover ring-1 ring-border"
            : isActive
              ? "bg-bg-hover"
              : "hover:bg-bg-hover"
        } ${isLongPressTarget ? "scale-[0.97] bg-bg-hover" : ""}`}
      >
        {indicator?.unread && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-3 rounded-full bg-text-primary" />
        )}
        <div className="flex items-center">
          <span
            {...attributes}
            {...listeners}
            className="w-0 overflow-hidden group-hover:w-4 text-text-faint hover:text-text-muted cursor-grab active:cursor-grabbing touch-none transition-all duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={12} />
          </span>
          {indicator?.busy ? (
            <span className="w-1.5 h-1.5 rounded-full shrink-0 ml-1 bg-info animate-pulse" />
          ) : indicator?.unread ? (
            <span className="w-1.5 h-1.5 rounded-full shrink-0 ml-1 bg-success" />
          ) : null}
          <span className={`truncate flex-1 ml-1 ${indicator?.unread ? "font-semibold" : "font-medium"} ${task.title === "New Task" ? "italic text-text-muted" : ""}`}>
            {task.title}
          </span>
          {task.pinned && (
            <Pin size={10} className="shrink-0 ml-0.5 text-text-muted rotate-45" />
          )}
          {/* Rail variant: tag dots + status label */}
          {isRail && (task.tags?.length ?? 0) > 0 && (
            <span className="flex gap-0.5 shrink-0 ml-1">
              {task.tags!.slice(0, 3).map((tag) => (
                <span key={tag.id} className={`w-1.5 h-1.5 rounded-full ${TAG_DOT[tag.color] ?? "bg-slate-500"}`} title={tag.name} />
              ))}
            </span>
          )}
          {isRail && (
            <span className={`text-[10px] ml-1 ${STATUS_TEXT[task.status]}`}>
              {task.status !== "active" ? task.status : ""}
            </span>
          )}
        </div>
        <div className="text-xs text-text-muted mt-0.5 transition-all duration-150 pl-0 group-hover:pl-4">
          {timeAgo(indicator?.lastActivity ?? task.updatedAt)}
          {(indicator?.busyCount ?? 0) > 0 && ` · ${indicator!.busyCount} in flight`}
          {(indicator?.unreadCount ?? 0) > 0 && ` · ${indicator!.unreadCount} unread`}
        </div>
      </button>
    </div>
  );
}
