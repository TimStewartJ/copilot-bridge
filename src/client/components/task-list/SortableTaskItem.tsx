import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { timeAgo } from "../../time";
import { TAG_COLOR_DOT as TAG_DOT } from "../../tag-colors";
import type { Task } from "../../api";
import type { TaskIndicator } from "../../hooks/useTaskIndicators";
import { getFollowUpState } from "../TaskMomentumFields";
import TaskKindBadge from "../TaskKindBadge";
import { getTaskStatusLabel, getTaskStatusTextClass } from "../../task-completion-helpers";



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
  const momentumBadges = getTaskListMomentumBadges(task);

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
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-1 animate-pulse ${indicator.stalled ? "bg-warning" : "bg-info"}`} />
          ) : indicator?.unread ? (
            <span className="w-1.5 h-1.5 rounded-full shrink-0 ml-1 bg-success" />
          ) : null}
          <span className={`truncate flex-1 ml-1 ${indicator?.unread ? "font-semibold" : "font-medium"} ${task.title === "New Task" ? "italic text-text-muted" : ""}`}>
            {task.title}
          </span>
          <TaskKindBadge kind={task.kind} iconOnly className="ml-1 shrink-0" />
          {/* Rail variant: tag dots + status label */}
          {isRail && (task.tags?.length ?? 0) > 0 && (
            <span className="flex gap-0.5 shrink-0 ml-1">
              {task.tags!.slice(0, 3).map((tag) => (
                <span key={tag.id} className={`w-1.5 h-1.5 rounded-full ${TAG_DOT[tag.color] ?? "bg-slate-500"}`} title={tag.name} />
              ))}
            </span>
          )}
          {isRail && (
            <span className={`text-[10px] ml-1 ${getTaskStatusTextClass(task)}`}>
              {getTaskStatusLabel(task) !== "Active" ? getTaskStatusLabel(task) : ""}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-text-muted transition-all duration-150 pl-0 group-hover:pl-4">
          {momentumBadges.map((badge) => (
            <span
              key={badge.label}
              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
              title={badge.title}
            >
              {badge.label}
            </span>
          ))}
          <span>{timeAgo(indicator?.lastActivity ?? task.updatedAt)}</span>
          {(indicator?.busyCount ?? 0) > 0 && <span>· {indicator!.busyCount} in flight</span>}
          {(indicator?.unreadCount ?? 0) > 0 && <span>· {indicator!.unreadCount} unread</span>}
        </div>
      </button>
    </div>
  );
}

export function getTaskListMomentumBadges(task: Task): Array<{ label: string; className: string; title?: string }> {
  const badges: Array<{ label: string; className: string; title?: string }> = [];
  const followUpState = task.status === "active" ? getFollowUpState(task.nextTouchAt) : null;

  if (followUpState === "overdue" || followUpState === "due") {
    badges.push({
      label: "Follow up",
      className: followUpState === "overdue" ? "bg-error/15 text-error" : "bg-warning/15 text-warning",
      title: task.nextTouchAt
        ? `Due ${new Date(task.nextTouchAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}`
        : undefined,
    });
  }
  if (task.status === "active" && !task.nextAction && !task.waitingOn && !task.nextTouchAt) {
    badges.push({
      label: "Needs decision",
      className: "bg-accent/15 text-accent",
      title: "No next action, waiting reason, or follow-up is set",
    });
  }

  return badges;
}
