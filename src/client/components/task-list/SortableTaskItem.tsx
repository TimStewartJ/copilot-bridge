import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { timeAgo } from "../../time";
import type { Task } from "../../api";
import type { TaskIndicator } from "../../hooks/useTaskIndicators";
import TaskKindBadge from "../TaskKindBadge";
import { UI } from "../shared/design-system";
import { getTaskRowSignals, shouldShowTaskRowUnreadDot, type TaskRowSignalTone } from "../../task-row-signals";



interface SortableTaskItemProps {
  task: Task;
  isActive: boolean;
  indicator: TaskIndicator | undefined;
  isCtxTarget: boolean;
  isLongPressTarget: boolean;
  bindLongPress: (id: string, onClick: () => void) => Record<string, unknown>;
  onSelectTask: (id: string) => void;
  /** "rail" shows status text and uses tighter padding; "list" is the mobile/simple variant */
  variant?: "rail" | "list";
}

const SIGNAL_TONE_CLASS: Record<TaskRowSignalTone, string> = {
  info: "border border-info-border bg-info-surface text-info",
  warning: "bg-warning/15 text-warning",
  success: "bg-success/15 text-success",
  danger: "bg-error/15 text-error",
  faint: "bg-text-faint/15 text-text-faint",
};

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
  const signals = getTaskRowSignals(task, indicator);
  const primarySignal = signals[0];
  const supportingSignal = signals
    .slice(1)
    .find((candidate) => candidate.kind !== "unread");
  const showUnreadDot = shouldShowTaskRowUnreadDot(task, indicator);

  return (
    <div ref={setNodeRef} style={style} className="group">
      <button
        {...bindLongPress(task.id, () => onSelectTask(task.id))}
        data-unread-task-id={showUnreadDot ? task.id : undefined}
        className={`relative w-full text-left px-3 ${isRail ? "py-2" : "py-2.5"} rounded-lg text-sm select-none no-callout transition-all duration-150 ${
          isCtxTarget
            ? "bg-bg-hover ring-1 ring-border"
            : isActive
              ? UI.surface.selectedRow
              : "hover:bg-bg-hover"
        } ${isLongPressTarget ? "scale-[0.97] bg-bg-hover" : ""}`}
      >
        {showUnreadDot && (
          <>
            <span aria-hidden="true" className="absolute left-1 top-3.5 h-1.5 w-1.5 rounded-full bg-success" />
            <span className="sr-only">New results</span>
          </>
        )}
        <div className="flex items-center gap-1.5">
          <span
            {...attributes}
            {...listeners}
            className={`${isRail ? "w-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" : "w-4 opacity-60"} shrink-0 overflow-hidden text-text-faint hover:text-text-muted cursor-grab active:cursor-grabbing touch-none transition-opacity duration-150`}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={12} />
          </span>
          <span className={`truncate flex-1 font-medium ${task.title === "New Task" ? "italic text-text-muted" : "text-text-primary"}`}>
            {task.title}
          </span>
          <TaskKindBadge kind={task.kind} iconOnly className="shrink-0" />
          {primarySignal && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${SIGNAL_TONE_CLASS[primarySignal.tone]}`}
              title={primarySignal.label}
            >
              {primarySignal.animated && (
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              )}
              {isRail ? primarySignal.shortLabel : primarySignal.label}
            </span>
          )}
        </div>
        <div className={`${isRail ? "pl-[18px]" : "pl-[22px]"} mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted`}>
          {task.muted && <span className="font-medium">muted</span>}
          {task.muted && <span className="text-text-faint">•</span>}
          {!task.muted && supportingSignal && (
            <>
              <span className="truncate font-medium" title={supportingSignal.label}>
                {isRail ? supportingSignal.shortLabel : supportingSignal.label}
              </span>
              <span className="text-text-faint">•</span>
            </>
          )}
          <span className="shrink-0">{timeAgo(indicator?.lastActivity ?? task.updatedAt)}</span>
        </div>
      </button>
    </div>
  );
}
