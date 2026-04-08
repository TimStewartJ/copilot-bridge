import { useState, useMemo, useCallback } from "react";
import type { Task, TaskGroup, Session } from "../api";
import { GROUP_COLOR_DOT, GROUP_COLOR_BG } from "../group-colors";
import { timeAgo } from "../time";
import { ChevronDown, ChevronRight, Copy, Check, Play, Pause, CheckCircle, Archive, ArchiveRestore, Trash2, Eye, GripVertical, FolderOpen, FolderMinus, ArrowUp, ArrowDown, Plus, FileText } from "lucide-react";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
import NotesSheet from "./NotesSheet";
import useLongPressMenu from "../hooks/useLongPressMenu";
import useCrossGroupDnd from "../hooks/useCrossGroupDnd";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const STATUS_ORDER = { active: 0, paused: 1, done: 2, archived: 3 } as const;



interface TaskListProps {
  tasks: Task[];
  taskGroups?: TaskGroup[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: (groupId?: string) => void;
  sessions?: Session[];
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => void;
  onDeleteTask?: (taskId: string) => void;
  onReorderTasks?: (taskIds: string[]) => void;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onMoveAndReorder?: (taskId: string, groupId: string | undefined, taskIds: string[]) => void;
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>) => void;
  onDeleteGroup?: (groupId: string) => void;
  onReorderGroups?: (groupIds: string[]) => void;
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
  onMoveAndReorder,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onReorderGroups,
  className,
}: TaskListProps) {
  // Build a lookup of sessionId → Session for quick access
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

  // Derive busy/unread status per task from linked sessions.
  // Busy sessions are excluded from the unread check — unread only applies
  // once a session goes idle with new content the user hasn't seen.
  const taskIndicators = useMemo(() => {
    const indicators = new Map<string, { busy: boolean; unread: boolean; busyCount: number; unreadCount: number }>();
    for (const task of tasks) {
      let busyCount = 0;
      let unreadCount = 0;
      for (const sid of task.sessionIds) {
        const session = sessionMap.get(sid);
        if (!session || session.archived) continue;
        if (session.busy) { busyCount++; continue; }
        if (isUnread?.(sid, session.modifiedTime)) unreadCount++;
      }
      indicators.set(task.id, { busy: busyCount > 0, unread: unreadCount > 0, busyCount, unreadCount });
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

  // Group notes sheet state
  const [groupNotesId, setGroupNotesId] = useState<string | null>(null);
  const [groupNotesStartEdit, setGroupNotesStartEdit] = useState(false);

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

  const allNonArchived = [...grouped.active, ...grouped.paused, ...grouped.done];

  const {
    sensors,
    activeDragTask,
    displaySections,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  } = useCrossGroupDnd({
    tasks: allNonArchived,
    groupedSections,
    hasGroups,
    onReorderTasks,
    onMoveTaskToGroup,
    onMoveAndReorder,
  });

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
        onClick={() => onNewTask()}
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
                <div className="flex items-center">
                  <button
                    onClick={() => {
                      if (group && onUpdateGroup) onUpdateGroup(group.id, { collapsed: !isCollapsed });
                    }}
                    className="flex-1 px-3 py-1.5 text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5"
                  >
                    {group ? (isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />) : null}
                    {group?.name ?? "Ungrouped"}
                  </button>
                  {group && (
                    <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setGroupNotesId(group.id);
                        setGroupNotesStartEdit(!group.notes);
                      }}
                      title={group.notes ? "Edit group notes" : "Add group notes"}
                      className="p-1 rounded text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                    >
                      <FileText size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewTask(group.id);
                      }}
                      title={`New task in ${group.name}`}
                      className="p-1 rounded text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                    </button>
                    </>
                  )}
                  {group && onReorderGroups && taskGroups.length > 1 && (() => {
                    const groupIndex = taskGroups.indexOf(group);
                    return (
                      <div className="flex items-center mr-1.5 gap-0.5">
                        <button
                          disabled={groupIndex === 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            const ids = taskGroups.map((g) => g.id);
                            [ids[groupIndex - 1], ids[groupIndex]] = [ids[groupIndex], ids[groupIndex - 1]];
                            onReorderGroups(ids);
                          }}
                          className="p-0.5 text-text-faint hover:text-text-primary disabled:opacity-30 disabled:pointer-events-none transition-colors rounded"
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          disabled={groupIndex === taskGroups.length - 1}
                          onClick={(e) => {
                            e.stopPropagation();
                            const ids = taskGroups.map((g) => g.id);
                            [ids[groupIndex], ids[groupIndex + 1]] = [ids[groupIndex + 1], ids[groupIndex]];
                            onReorderGroups(ids);
                          }}
                          className="p-0.5 text-text-faint hover:text-text-primary disabled:opacity-30 disabled:pointer-events-none transition-colors rounded"
                        >
                          <ArrowDown size={12} />
                        </button>
                      </div>
                    );
                  })()}
                </div>
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

      {/* Group notes sheet */}
      {groupNotesId && (() => {
        const group = taskGroups.find((g) => g.id === groupNotesId);
        if (!group) return null;
        return (
          <NotesSheet
            notes={group.notes}
            startInEditMode={groupNotesStartEdit}
            onSave={(newNotes) => {
              if (onUpdateGroup) onUpdateGroup(group.id, { notes: newNotes });
            }}
            onClose={() => setGroupNotesId(null)}
          />
        );
      })()}
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
  indicator: { busy: boolean; unread: boolean; busyCount: number; unreadCount: number } | undefined;
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

  return (
    <div ref={setNodeRef} style={style} className="group">
      <button
        {...bindLongPress(task.id, () => onSelectTask(task.id))}
        className={`w-full text-left px-3 py-2.5 rounded-md text-sm select-none no-callout transition-all duration-150 ${
          isCtxTarget
            ? "bg-bg-hover ring-1 ring-border"
            : isActive && indicator?.unread
              ? "bg-bg-hover border-l-2 border-text-primary"
              : isActive
                ? "bg-bg-hover"
                : indicator?.unread
                  ? "border-l-2 border-text-primary hover:bg-bg-hover"
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
          {(indicator?.busyCount ?? 0) > 0 && ` · ${indicator!.busyCount} in flight`}
          {(indicator?.unreadCount ?? 0) > 0 && ` · ${indicator!.unreadCount} unread`}
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