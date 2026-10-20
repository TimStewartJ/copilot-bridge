import type { PointerEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { Task } from "../../api";
import type { TaskIndicator } from "../../hooks/useTaskIndicators";
import type { LongPressBindings } from "../../hooks/useLongPressMenu";
import TaskKindBadge from "../TaskKindBadge";
import { DS, type DsStatusKind } from "../../design/tokens";
import { IconButton, StatusIcon } from "../../design/primitives";
import { shouldShowTaskRowUnreadDot, type TaskRowSignal } from "../../task-row-signals";
import TaskAttentionBadge from "../TaskAttentionBadge";
import { getTaskLifecycleDisplayState } from "../../task-completion-helpers";

interface SortableTaskItemProps {
  task: Task;
  isActive: boolean;
  indicator: TaskIndicator | undefined;
  isCtxTarget: boolean;
  isLongPressTarget: boolean;
  bindLongPress: (id: string, onClick: () => void) => LongPressBindings;
  onSelectTask: (id: string) => void;
  /** "rail" uses tighter padding and shorter labels; "list" is the phone variant. */
  variant?: "rail" | "list";
  /** Mouse or pen drag on the whole row starts a reorder. The rail uses this; touch never does. */
  rowDrag?: boolean;
  /** Reorder mode: the row stops opening the task and shows a drag handle beside it. */
  reordering?: boolean;
  attention?: TaskRowSignal | null;
  /** Leading glyph: the attention mark, or the working spinner when a turn is running. */
  glyph?: DsStatusKind | null;
  activityDescription?: string;
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
  rowDrag = false,
  reordering = false,
  attention = null,
  glyph = attention?.status ?? null,
  activityDescription,
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
  const showUnreadDot = shouldShowTaskRowUnreadDot(task, indicator);
  const emphasizeTitle = showUnreadDot || attention?.kind === "needs-input";
  const lifecycle = getTaskLifecycleDisplayState(task);
  const lifecycleLabel = lifecycle === "completed" ? "Completed" : lifecycle === "archived" ? "Archived"
    : task.muted ? "Muted" : task.deferred ? "Deferred" : null;

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
          {glyph && <StatusIcon kind={glyph} decorative />}
        </span>
        <span className={`truncate flex-1 ${emphasizeTitle ? "font-semibold" : "font-medium"} ${task.title === "New Task" ? "italic text-text-muted" : "text-text-primary"}`}>
          {task.title}
        </span>
        <TaskKindBadge kind={task.kind} iconOnly className="shrink-0" />
        {attention && <TaskAttentionBadge signal={attention} compact={isRail} />}
        {lifecycleLabel && <span className={DS.text.meta}>{lifecycleLabel}</span>}
      </div>
    </>
  );

  return (
    <div ref={setNodeRef} style={style} className="group flex items-center border-b border-border-subtle last:border-b-0">
      {reordering ? (
        <div data-task-id={task.id} data-unread-task-id={showUnreadDot ? task.id : undefined} className={rowClassName} title={attention?.detail ?? activityDescription}>
          {content}
        </div>
      ) : (
        <button
          type="button"
          {...bindLongPress(task.id, () => onSelectTask(task.id))}
          {...rowDragProps}
          data-unread-task-id={showUnreadDot ? task.id : undefined}
          data-task-id={task.id}
          data-task-attention={attention?.kind}
          title={attention?.detail ?? activityDescription}
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
