import { useState, useMemo, useCallback } from "react";
import type { Task, TaskGroup, Session } from "../api";
import { GROUP_COLOR_DOT, GROUP_COLOR_BG } from "../group-colors";
import { ChevronDown, ChevronRight, Copy, Check, Play, Pause, CheckCircle, Archive, ArchiveRestore, Trash2, Eye, GripVertical, FolderOpen, FolderMinus } from "lucide-react";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
import useLongPressMenu from "../hooks/useLongPressMenu";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
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
  taskGroups?: TaskGroup[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  sessions?: Session[];
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => void;
  onDeleteTask?: (taskId: string) => void;
  onReorderTasks?: (taskIds: string[]) => void;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed">>) => void;
  onDeleteGroup?: (groupId: string) => void;
  className?: string;
}

export default function TaskList({
  tasks,
  taskGroups = [],
  activeTaskId,
  onSelectTask,
  onNewTask,
  sessions = [],
  isUnread,
  markRead,
  onUpdateTask,
  onDeleteTask,
  onReorderTasks,
  onMoveTaskToGroup,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  className,
}: TaskListProps) {
  // Build a lookup of sessionId → Session for quick access
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

  // Derive busy/unread status per task from linked sessions (independent flags)
  const taskIndicators = useMemo(() => {
    const indicators = new Map<string, { busy: boolean; unread: boolean }>();
    for (const task of tasks) {
      let hasBusy = false;
      let hasUnread = false;
      for (const sid of task.sessionIds) {
        const session = sessionMap.get(sid);
        if (!session || session.archived) continue;
        if (session.busy) hasBusy = true;
        if (isUnread?.(sid, session.modifiedTime)) hasUnread = true;
      }
      indicators.set(task.id, { busy: hasBusy, unread: hasUnread });
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

  const hasGroups = taskGroups.length > 0;

  const groupedSections = useMemo(() => {
    if (!hasGroups) return null;
    const nonArchived = sorted.filter((t) => t.status !== "archived");
    const sections: { group: TaskGroup | null; tasks: Task[] }[] = [];
    for (const group of taskGroups) {
      const groupTasks = nonArchived.filter((t) => t.groupId === group.id);
      sections.push({ group, tasks: groupTasks });
    }
    const ungrouped = nonArchived.filter((t) => !t.groupId || !taskGroups.some((g) => g.id === t.groupId));
    if (ungrouped.length > 0) {
      sections.push({ group: null, tasks: ungrouped });
    }
    return sections;
  }, [hasGroups, sorted, taskGroups]);

  // DnD setup
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  type Section = { group: TaskGroup | null; tasks: Task[] };
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localSections, setLocalSections] = useState<Section[] | null>(null);
  const allNonArchived = [...grouped.active, ...grouped.paused, ...grouped.done];
  const activeDragTask = activeId ? allNonArchived.find((t) => t.id === activeId) : null;
  const displaySections = localSections ?? groupedSections;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
    if (groupedSections) {
      setLocalSections(groupedSections.map((s) => ({ ...s, tasks: [...s.tasks] })));
    }
  }, [groupedSections]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || !localSections || !hasGroups) return;

    const dragId = active.id as string;
    const fromSection = localSections.find((s) => s.tasks.some((t) => t.id === dragId));
    if (!fromSection) return;

    let toSection: Section | undefined;
    let overIndex: number;

    const overIsTask = localSections.some((s) => s.tasks.some((t) => t.id === over.id));
    if (overIsTask) {
      toSection = localSections.find((s) => s.tasks.some((t) => t.id === over.id));
      overIndex = toSection ? toSection.tasks.findIndex((t) => t.id === over.id) : 0;
    } else {
      toSection = localSections.find((s) => (s.group?.id ?? "__ungrouped__") === over.id);
      overIndex = toSection ? toSection.tasks.length : 0;
    }

    if (!toSection || fromSection === toSection) return;

    const draggedTask = fromSection.tasks.find((t) => t.id === dragId);
    if (!draggedTask) return;

    setLocalSections((prev) => {
      if (!prev) return prev;
      return prev.map((s) => {
        if (s.group?.id === fromSection.group?.id && s.group?.id !== toSection!.group?.id) {
          return { ...s, tasks: s.tasks.filter((t) => t.id !== dragId) };
        }
        if (s.group?.id === toSection!.group?.id && s.group?.id !== fromSection.group?.id) {
          const newTasks = [...s.tasks.filter((t) => t.id !== dragId)];
          newTasks.splice(overIndex, 0, draggedTask);
          return { ...s, tasks: newTasks };
        }
        if (!s.group && !fromSection.group && toSection!.group) {
          return { ...s, tasks: s.tasks.filter((t) => t.id !== dragId) };
        }
        if (!s.group && !toSection!.group && fromSection.group) {
          const newTasks = [...s.tasks.filter((t) => t.id !== dragId)];
          newTasks.splice(overIndex, 0, draggedTask);
          return { ...s, tasks: newTasks };
        }
        return s;
      });
    });
  }, [localSections, hasGroups]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setLocalSections(null);

    if (!over || active.id === over.id || !onReorderTasks) return;

    const activeTask = allNonArchived.find((t) => t.id === active.id);
    if (!activeTask) return;

    // Check if dropped on a group container
    const overTask = allNonArchived.find((t) => t.id === over.id);
    if (!overTask && hasGroups && onMoveTaskToGroup) {
      const targetGroupId = over.id === "__ungrouped__" ? undefined : over.id as string;
      onMoveTaskToGroup(activeTask.id, targetGroupId);
      return;
    }

    if (!overTask) return;

    // Cross-group
    if (hasGroups && activeTask.groupId !== overTask.groupId && onMoveTaskToGroup) {
      onMoveTaskToGroup(activeTask.id, overTask.groupId);
      const targetGroupTasks = allNonArchived.filter(
        (t) => t.groupId === overTask.groupId && t.id !== activeTask.id,
      );
      const overIndex = targetGroupTasks.findIndex((t) => t.id === over.id);
      targetGroupTasks.splice(overIndex, 0, activeTask);
      onReorderTasks(targetGroupTasks.map((t) => t.id));
      return;
    }

    if (activeTask.status !== overTask.status) return;

    const group = grouped[activeTask.status] as Task[];
    const oldIndex = group.findIndex((t) => t.id === active.id);
    const newIndex = group.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...group];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    onReorderTasks(reordered.map((t) => t.id));
  }, [allNonArchived, grouped, onReorderTasks, hasGroups, onMoveTaskToGroup]);

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
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
        {hasGroups && displaySections ? (
          displaySections.map((section) => {
            const group = section.group;
            const isCollapsed = group?.collapsed ?? false;
            const groupId = group?.id ?? "__ungrouped__";
            const colorBg = group ? GROUP_COLOR_BG[group.color] ?? "bg-slate-500/8" : undefined;

            return (
              <DroppableGroup key={groupId} id={groupId}>
                <div className={colorBg ? `${colorBg} rounded-lg` : ""}>
                <button
                  onClick={() => {
                    if (group && onUpdateGroup) onUpdateGroup(group.id, { collapsed: !isCollapsed });
                  }}
                  className="w-full px-3 py-1.5 text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5"
                >
                  {group ? (isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />) : null}
                  {group?.name ?? "Ungrouped"} ({section.tasks.length})
                </button>
                {!isCollapsed && (
                  <SortableContext items={section.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                    {section.tasks.map((task) => (
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
                )}
                </div>
              </DroppableGroup>
            );
          })
        ) : (
          <>
            {renderGroup("Active", grouped.active)}
            {renderGroup("Paused", grouped.paused)}
            {renderGroup("Done", grouped.done)}
          </>
        )}
        <DragOverlay dropAnimation={null}>
          {activeDragTask ? (
            <div className="bg-bg-secondary rounded-md shadow-lg border border-border px-3 py-2 text-sm w-48 opacity-90">
              <div className="font-medium truncate">{activeDragTask.title}</div>
              <div className="text-xs text-text-muted mt-0.5">{timeAgo(activeDragTask.updatedAt)}</div>
            </div>
          ) : null}
        </DragOverlay>
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

          {/* Move to Group */}
          {onMoveTaskToGroup && taskGroups.length > 0 && (
            <>
              <CtxDivider />
              <div className="px-3 py-1 text-[10px] font-semibold text-text-faint uppercase tracking-wider">Move to Group</div>
              {taskGroups.map((g) => (
                <CtxItem
                  key={g.id}
                  icon={<span className={`w-2.5 h-2.5 rounded-full ${GROUP_COLOR_DOT[g.color] ?? "bg-slate-500"}`} />}
                  label={g.name}
                  className={ctxTask.groupId === g.id ? "text-accent font-medium" : ""}
                  onClick={() => {
                    if (ctxTask.groupId !== g.id) onMoveTaskToGroup(ctxTask.id, g.id);
                    closeMenu();
                  }}
                />
              ))}
              {ctxTask.groupId && (
                <CtxItem
                  icon={<FolderMinus size={14} />}
                  label="Remove from group"
                  onClick={() => { onMoveTaskToGroup(ctxTask.id, undefined); closeMenu(); }}
                />
              )}
            </>
          )}
          {onMoveTaskToGroup && onCreateGroup && (
            <>
              {taskGroups.length === 0 && <CtxDivider />}
              <CtxItem
                icon={<FolderOpen size={14} />}
                label="New Group..."
                onClick={async () => {
                  closeMenu();
                  const name = window.prompt("Group name:");
                  if (name?.trim()) {
                    const group = await onCreateGroup(name.trim());
                    if (group) onMoveTaskToGroup(ctxTask.id, group.id);
                  }
                }}
              />
            </>
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
  indicator: { busy: boolean; unread: boolean } | undefined;
  isCtxTarget: boolean;
  isLongPressTarget: boolean;
  bindLongPress: (id: string, onClick: () => void) => Record<string, unknown>;
  onSelectTask: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const linkCount =
    task.sessionIds.length +
    task.workItems.length +
    task.pullRequests.length;

  return (
    <div ref={setNodeRef} style={style} className="group">
      <button
        {...bindLongPress(task.id, () => onSelectTask(task.id))}
        className={`w-full text-left px-3 py-2.5 rounded-md text-sm select-none no-callout transition-all duration-150 ${
          isCtxTarget
            ? "bg-bg-hover ring-1 ring-border"
            : isActive
              ? "bg-bg-hover border-l-2 border-text-muted"
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
          {indicator?.busy ? (
            <span className="w-1.5 h-1.5 rounded-full shrink-0 ml-1 bg-info animate-pulse" />
          ) : indicator?.unread ? (
            <span className="w-1.5 h-1.5 rounded-full shrink-0 ml-1 bg-success" />
          ) : null}
          <span className={`truncate flex-1 ml-1 ${indicator?.unread ? "font-semibold" : "font-medium"} ${task.title === "New Task" ? "italic text-text-muted" : ""}`}>
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

// ── Droppable group container ────────────────────────────────────

function DroppableGroup({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef}>{children}</div>;
}