import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { timeAgo } from "../../time";
import type { Task } from "../../api";
import type { TaskIndicator } from "../../hooks/useTaskIndicators";
import type { LongPressBindings } from "../../hooks/useLongPressMenu";
import TaskKindBadge from "../TaskKindBadge";
import { DS, cx } from "../../design/tokens";
import {
  getTaskActivityDot,
  getTaskRowSignals,
  shouldShowTaskRowUnreadDot,
  type TaskRowSignalTone,
} from "../../task-row-signals";



interface SortableTaskItemProps {
  task: Task;
  isActive: boolean;
  indicator: TaskIndicator | undefined;
  isCtxTarget: boolean;
  isLongPressTarget: boolean;
  bindLongPress: (id: string, onClick: () => void) => LongPressBindings;
  onSelectTask: (id: string) => void;
  /** "rail" shows status text and uses tighter padding; "list" is the mobile/simple variant */
  variant?: "rail" | "list";
}

const SIGNAL_TONE: Record<TaskRowSignalTone, keyof typeof DS.badge.tone> = {
  info: "info",
  warning: "warning",
  success: "success",
  danger: "danger",
  faint: "neutral",
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
    .find((candidate) => candidate.kind === "deferred" && candidate !== primarySignal) ?? signals
    .slice(1)
    .find((candidate) => candidate.kind !== "unread");
  const activityDot = getTaskActivityDot(indicator);
  const showUnreadDot = shouldShowTaskRowUnreadDot(task, indicator);

  return (
    <div ref={setNodeRef} style={style} className="group border-b border-border-subtle last:border-b-0">
      <button
        {...bindLongPress(task.id, () => onSelectTask(task.id))}
        data-unread-task-id={showUnreadDot ? task.id : undefined}
        className={`relative w-full text-left px-3 ${isRail ? "py-2" : "py-2.5"} rounded-lg text-sm select-none no-callout transition-all duration-150 ${
          isCtxTarget
            ? "bg-bg-hover ring-1 ring-border"
            : isActive
              ? DS.row.selected
              : "hover:bg-bg-hover/60"
        } ${isLongPressTarget ? "scale-[0.97] bg-bg-hover" : ""}`}
      >
        {showUnreadDot && (
          <>
            <span aria-hidden="true" className="absolute left-1 top-3.5 h-1.5 w-1.5 rounded-full bg-success" />
            <span className="sr-only">Unread conversations</span>
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
          {activityDot && (
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot.animated ? "animate-pulse" : ""} ${
                activityDot.tone === "warning" ? "bg-warning" : "bg-info"
              }`}
            />
          )}
          <span className={`truncate flex-1 font-medium ${task.title === "New Task" ? "italic text-text-muted" : "text-text-primary"}`}>
            {task.title}
          </span>
          <TaskKindBadge kind={task.kind} iconOnly className="shrink-0" />
          {primarySignal && (
            <span
              className={cx(DS.badge.base, DS.badge.tone[SIGNAL_TONE[primarySignal.tone]])}
              title={primarySignal.label}
            >
              {primarySignal.animated && !activityDot && (
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              )}
              {isRail ? primarySignal.shortLabel : primarySignal.label}
            </span>
          )}
        </div>
        {(task.nextAction || task.waitingOn) && <p className={cx(DS.text.meta, isRail ? "pl-[18px]" : "pl-[22px]", "mt-1 truncate")}
          title={task.nextAction || task.waitingOn}>
          {task.nextAction ? `${task.deferred ? "When resumed" : "Next step"}: ${task.nextAction}` : `Waiting for: ${task.waitingOn}`}
        </p>}
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
