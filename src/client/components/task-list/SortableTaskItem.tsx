import type { PointerEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { timeAgo } from "../../time";
import type { Task } from "../../api";
import type { TaskIndicator } from "../../hooks/useTaskIndicators";
import type { LongPressBindings } from "../../hooks/useLongPressMenu";
import TaskKindBadge from "../TaskKindBadge";
import { DS, cx } from "../../design/tokens";
import { IconButton, StatusIcon } from "../../design/primitives";
import {
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
  /** Mouse or pen drag on the whole row starts a reorder. The rail uses this; touch never does. */
  rowDrag?: boolean;
  /** Reorder mode: the row stops opening the task and shows a drag handle beside it. */
  reordering?: boolean;
}

const SIGNAL_TONE: Record<TaskRowSignalTone, keyof typeof DS.badge.tone> = {
  accent: "accent",
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
  rowDrag = false,
  reordering = false,
}: SortableTaskItemProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !rowDrag && !reordering,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const isRail = variant === "rail";
  const allSignals = getTaskRowSignals(task, indicator);
  // An open question and a working agent are marked in the leading slot the unread dot uses,
  // not as badges. Priority there: answer needed, then working, then unread.
  const needsInputSignal = allSignals.find((candidate) => candidate.kind === "needs-input");
  const busySignal = allSignals.find((candidate) => candidate.kind === "busy");
  const signals = allSignals.filter((candidate) => candidate.kind !== "needs-input" && candidate.kind !== "busy");
  const primarySignal = signals[0];
  const supportingSignal = signals
    .find((candidate) => candidate.kind === "deferred" && candidate !== primarySignal) ?? signals
    .slice(1)
    .find((candidate) => candidate.kind !== "unread");
  const showUnreadDot = shouldShowTaskRowUnreadDot(task, indicator);
  const emphasizeTitle = showUnreadDot || Boolean(needsInputSignal);

  const onRowPointerDown = listeners?.onPointerDown as ((event: PointerEvent<HTMLElement>) => void) | undefined;
  const rowDragProps = rowDrag && !reordering && onRowPointerDown
    ? {
      ref: setActivatorNodeRef,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === "touch") return;
        onRowPointerDown(event);
      },
    }
    : {};

  const rowClassName = `relative min-w-0 flex-1 text-left px-3 ${isRail ? "py-2" : "py-2.5"} rounded-lg text-sm select-none no-callout transition-all duration-150 ${
    isCtxTarget
      ? "bg-bg-hover ring-1 ring-border"
      : isActive
        ? DS.row.selected
        : reordering ? "" : "hover:bg-bg-hover/60"
  } ${isLongPressTarget ? "scale-[0.97] bg-bg-hover" : ""}`;

  const content = (
    <>
      <div className="flex items-center gap-1.5">
        <span data-task-row-leading="" className="flex w-3 shrink-0 items-center justify-center">
          {needsInputSignal ? (
            <StatusIcon kind="needs-input" label={needsInputSignal.label} />
          ) : busySignal ? (
            <StatusIcon kind="working" label={busySignal.label} />
          ) : showUnreadDot && (
            <>
              <StatusIcon kind="unread" decorative />
              <span className="sr-only">Unread conversations</span>
            </>
          )}
        </span>
        <span className={`truncate flex-1 ${emphasizeTitle ? "font-semibold" : "font-medium"} ${task.title === "New Task" ? "italic text-text-muted" : "text-text-primary"}`}>
          {task.title}
        </span>
        <TaskKindBadge kind={task.kind} iconOnly className="shrink-0" />
        {primarySignal && (
          <span
            className={cx(DS.badge.base, DS.badge.tone[SIGNAL_TONE[primarySignal.tone]])}
            title={primarySignal.label}
          >
            {primarySignal.status !== "unread" && <StatusIcon kind={primarySignal.status} decorative />}
            {isRail ? primarySignal.shortLabel : primarySignal.label}
          </span>
        )}
      </div>
      {(task.nextAction || task.waitingOn) && <p className={cx(DS.text.meta, "pl-[18px] mt-1 truncate")}
        title={task.nextAction || task.waitingOn}>
        {task.nextAction ? `${task.deferred ? "When resumed" : "Next step"}: ${task.nextAction}` : `Waiting for: ${task.waitingOn}`}
      </p>}
      <div className="pl-[18px] mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted">
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
    </>
  );

  return (
    <div ref={setNodeRef} style={style} className="group flex items-center border-b border-border-subtle last:border-b-0">
      {reordering ? (
        <div data-unread-task-id={showUnreadDot ? task.id : undefined} className={rowClassName}>
          {content}
        </div>
      ) : (
        <button
          type="button"
          {...bindLongPress(task.id, () => onSelectTask(task.id))}
          {...rowDragProps}
          data-unread-task-id={showUnreadDot ? task.id : undefined}
          className={rowClassName}
        >
          {content}
        </button>
      )}
      {reordering && (
        <IconButton
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          label={`Reorder ${task.title}`}
          data-task-reorder-handle={task.id}
          className="mr-1 cursor-grab touch-none text-text-muted active:cursor-grabbing"
        >
          <GripVertical size={16} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
