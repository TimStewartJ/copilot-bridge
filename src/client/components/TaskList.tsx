import { useState, useMemo, useCallback } from "react";
import type { Task, Session } from "../api";
import { ChevronDown, ChevronRight, Copy, Check, Play, Pause, CheckCircle, Archive, ArchiveRestore, Trash2, Eye, GripVertical } from "lucide-react";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
import useLongPressMenu from "../hooks/useLongPressMenu";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const STATUS_ORDER = { active: 0, paused: 1, done: 2, archived: 3 } as const;

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface TaskListProps {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  sessions?: Session[];
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => void;
  onDeleteTask?: (taskId: string) => void;
  onReorderTasks?: (taskIds: string[]) => void;
  className?: string;
}

export default function TaskList({
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
  sessions = [],
  isUnread,
  markRead,
  onUpdateTask,
  onDeleteTask,
  onReorderTasks,
  className,
}: TaskListProps) {
  // Build a lookup of sessionId → Session for quick access
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

  // Derive busy/unread status per task from linked sessions
  const taskIndicators = useMemo(() => {
    const indicators = new Map<string, "busy" | "unread" | null>();
    for (const task of tasks) {
      let hasBusy = false;
      let hasUnread = false;
      for (const sid of task.sessionIds) {
        const session = sessionMap.get(sid);
        if (!session || session.archived) continue;
        if (session.busy) hasBusy = true;
        if (isUnread?.(sid, session.modifiedTime)) hasUnread = true;
      }
      indicators.set(task.id, hasBusy ? "busy" : hasUnread ? "unread" : null);
    }
    return indicators;
  }, [tasks, sessionMap, isUnread]);

  // Context menu state
  const { bind: bindLongPress, menu: ctxMenu, closeMenu: rawCloseMenu, isTarget } = useLongPressMenu<string>();
  const [copied, setCopied] = useState(false);
  const closeMenu = useCallback(() => { rawCloseMenu(); setCopied(false); }, [rawCloseMenu]);

  const ctxTask = ctxMenu ? tasks.find((t) => t.id === ctxMenu.id) : null;

  // Count unread sessions for context-menu'd task
  const ctxUnreadCount = useMemo(() => {
    if (!ctxTask || !isUnread) return 0;
    return ctxTask.sessionIds.filter((sid) => {
      const session = sessionMap.get(sid);
      return session && isUnread(sid, session.modifiedTime);
    }).length;
  }, [ctxTask, sessionMap, isUnread]);

  const sorted = [...tasks].sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    return a.order - b.order;
  });

  const grouped = {
    active: sorted.filter((t) => t.status === "active"),
    paused: sorted.filter((t) => t.status === "paused"),
    done: sorted.filter((t) => t.status === "done"),
    archived: sorted.filter((t) => t.status === "archived"),
  };

  const [showArchived, setShowArchived] = useState(false);

  // DnD setup
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !onReorderTasks) return;

    // Find which group these belong to
    const allNonArchived = [...grouped.active, ...grouped.paused, ...grouped.done];
    const activeTask = allNonArchived.find((t) => t.id === active.id);
    const overTask = allNonArchived.find((t) => t.id === over.id);
    if (!activeTask || !overTask || activeTask.status !== overTask.status) return;

    const group = grouped[activeTask.status] as Task[];
    const oldIndex = group.findIndex((t) => t.id === active.id);
    const newIndex = group.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...group];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    onReorderTasks(reordered.map((t) => t.id));
  }, [grouped, onReorderTasks]);

  const renderGroup = (label: string, items: Task[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label}>
        <div className="px-3 py-1.5 text-xs font-medium text-text-muted uppercase tracking-wider">
          {label} ({items.length})
        </div>
        <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {items.map((task) => (
            <SortableListItem
              key={task.id}
              task={task}
              isActive={task.id === activeTaskId}
              indicator={taskIndicators.get(task.id)}
              isCtxTarget={ctxMenu?.id === task.id}
              isLongPressTarget={isTarget(task.id)}
              bindLongPress={bindLongPress}
              onSelectTask={onSelectTask}
            />
          ))}
        </SortableContext>
      </div>
    );
  };

  return (
    <div className={className ?? "flex-1 overflow-y-auto p-2 space-y-2"}>
      <button
        onClick={onNewTask}
        className="w-full px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors"
      >
        + New Task
      </button>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        {renderGroup("Active", grouped.active)}
        {renderGroup("Paused", grouped.paused)}
        {renderGroup("Done", grouped.done)}
      </DndContext>
      {grouped.archived.length > 0 && (
        <>
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="w-full px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors flex items-center gap-1"
          >
            {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />} Archived ({grouped.archived.length})
          </button>
          {showArchived && renderGroup("Archived", grouped.archived)}
        </>
      )}
      {tasks.length === 0 && (
        <div className="text-center text-text-muted text-sm py-8">
          No tasks yet
        </div>
      )}

      {/* Task context menu */}
      {ctxMenu && ctxTask && (
        <ContextMenu position={ctxMenu} onClose={closeMenu}>
          {/* Mark all as read */}
          {markRead && (
            <CtxItem
              icon={<Eye size={14} />}
              label={`Mark all as read${ctxUnreadCount > 0 ? ` (${ctxUnreadCount})` : ""}`}
              disabled={ctxUnreadCount === 0}
              onClick={() => {
                for (const sid of ctxTask.sessionIds) {
                  const session = sessionMap.get(sid);
                  if (session && isUnread?.(sid, session.modifiedTime)) {
                    markRead(sid);
                  }
                }
                closeMenu();
              }}
            />
          )}

          {/* Copy Task ID */}
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              navigator.clipboard.writeText(ctxTask.id);
              setCopied(true);
              setTimeout(closeMenu, 600);
            }}
          >
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            {copied ? "Copied!" : "Copy Task ID"}
          </button>

          <CtxDivider />

          {/* Status changes */}
          {onUpdateTask && ctxTask.status !== "active" && (
            <CtxItem
              icon={<Play size={14} />}
              label="Set Active"
              onClick={() => { onUpdateTask(ctxTask.id, { status: "active" }); closeMenu(); }}
            />
          )}
          {onUpdateTask && ctxTask.status !== "paused" && ctxTask.status !== "archived" && (
            <CtxItem
              icon={<Pause size={14} />}
              label="Set Paused"
              onClick={() => { onUpdateTask(ctxTask.id, { status: "paused" }); closeMenu(); }}
            />
          )}
          {onUpdateTask && ctxTask.status !== "done" && ctxTask.status !== "archived" && (
            <CtxItem
              icon={<CheckCircle size={14} />}
              label="Set Done"
              onClick={() => { onUpdateTask(ctxTask.id, { status: "done" }); closeMenu(); }}
            />
          )}
          {onUpdateTask && (
            <CtxItem
              icon={ctxTask.status === "archived" ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              label={ctxTask.status === "archived" ? "Unarchive" : "Archive"}
              onClick={() => {
                onUpdateTask(ctxTask.id, { status: ctxTask.status === "archived" ? "active" : "archived" });
                closeMenu();
              }}
            />
          )}

          {/* Delete */}
          {onDeleteTask && (
            <>
              <CtxDivider />
              <CtxItem
                icon={<Trash2 size={14} />}
                label="Delete"
                className="text-error"
                onClick={() => { onDeleteTask(ctxTask.id); closeMenu(); }}
              />
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}

// ── Sortable task item for task list ──────────────────────────────

function SortableListItem({
  task,
  isActive,
  indicator,
  isCtxTarget,
  isLongPressTarget,
  bindLongPress,
  onSelectTask,
}: {
  task: Task;
  isActive: boolean;
  indicator: "busy" | "unread" | null | undefined;
  isCtxTarget: boolean;
  isLongPressTarget: boolean;
  bindLongPress: (id: string, onClick: () => void) => Record<string, unknown>;
  onSelectTask: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const linkCount =
    task.sessionIds.length +
    task.workItemIds.length +
    task.pullRequests.length;

  return (
    <div ref={setNodeRef} style={style} className="group">
      <button
        {...bindLongPress(task.id, () => onSelectTask(task.id))}
        className={`w-full text-left px-3 py-2.5 rounded-md text-sm select-none no-callout transition-all duration-150 ${
          isCtxTarget
            ? "bg-bg-hover ring-1 ring-border"
            : isActive
              ? "bg-accent/10 border-l-2 border-accent"
              : "hover:bg-bg-hover"
        } ${isLongPressTarget ? "scale-[0.97] bg-bg-hover" : ""}`}
      >
        <div className="flex items-center">
          <span
            {...attributes}
            {...listeners}
            className="w-0 overflow-hidden group-hover:w-4 text-text-faint hover:text-text-muted cursor-grab active:cursor-grabbing touch-none transition-all duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={12} />
          </span>
          {indicator && (
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ml-1 ${
                indicator === "busy"
                  ? "bg-info animate-pulse"
                  : "bg-success"
              }`}
            />
          )}
          <span className={`font-medium truncate flex-1 ml-1 ${task.title === "New Task" ? "italic text-text-muted" : ""}`}>
            {task.title}
          </span>
        </div>
        <div className="text-xs text-text-muted mt-0.5 transition-all duration-150 pl-0 group-hover:pl-4">
          {timeAgo(task.updatedAt)}
          {linkCount > 0 && ` · ${linkCount} linked`}
        </div>
      </button>
    </div>
  );
}
