import { useState, useMemo, useEffect, useRef } from "react";
import { type Task, type TaskGroup, type Session, type TaskPatch } from "../api";
import { GROUP_COLOR_BG } from "../group-colors";
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown, Plus, FileText } from "lucide-react";
import NotesSheet from "./NotesSheet";
import EmptyState from "./shared/EmptyState";
import useLongPressMenu from "../hooks/useLongPressMenu";
import useTaskIndicators from "../hooks/useTaskIndicators";
import useCrossGroupDnd from "../hooks/useCrossGroupDnd";
import { groupTasksByStatus, buildGroupSections } from "../task-helpers";
import { SortableTaskItem, DroppableGroup, TaskDragOverlay, TaskContextMenu, UnreadTaskEdgePill, useUnreadTaskEdges } from "./task-list";
import { UI } from "./shared/design-system";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";



interface TaskListProps {
  tasks: Task[];
  taskGroups?: TaskGroup[];
  activeTaskId: string | null;
  activeSessionId?: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: (groupId?: string) => void;
  sessions?: Session[];
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (
    taskId: string,
    updates: {
      title?: TaskPatch["title"];
      muted?: TaskPatch["muted"];
      status?: TaskPatch["status"];
      nextTouchAt?: TaskPatch["nextTouchAt"];
      completionAction?: TaskPatch["completionAction"];
    },
  ) => void;
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
  activeSessionId,
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
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

  const taskIndicators = useTaskIndicators(tasks, sessions, isUnread, activeSessionId);

  const { bind: bindLongPress, menu: ctxMenu, closeMenu, isTarget } = useLongPressMenu<string>();
  const ctxTask = ctxMenu ? tasks.find((t) => t.id === ctxMenu.id) : null;

  const grouped = useMemo(() => groupTasksByStatus(tasks), [tasks]);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (tasks.some((task) => task.id === activeTaskId && task.status === "archived")) {
      setShowArchived(true);
    }
  }, [activeTaskId, tasks]);

  // Group notes sheet state
  const [groupNotesId, setGroupNotesId] = useState<string | null>(null);
  const [groupNotesStartEdit, setGroupNotesStartEdit] = useState(false);

  const hasGroups = taskGroups.length > 0;

  const groupedSections = useMemo(() => {
    if (!hasGroups) return null;
    const nonArchived = [...grouped.active, ...grouped.done];
    return buildGroupSections(nonArchived, taskGroups);
  }, [hasGroups, grouped, taskGroups]);

  const allNonArchived = [...grouped.active, ...grouped.done];

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
  const unreadTaskEdgeRefreshKey = useMemo(() => {
    const parts: string[] = [showArchived ? "archived" : "open"];
    const addTask = (task: Task) => {
      parts.push(`${task.id}:${taskIndicators.get(task.id)?.unread ? "1" : "0"}`);
    };
    if (hasGroups && displaySections) {
      for (const section of displaySections) {
        if (section.group?.collapsed) continue;
        for (const task of section.tasks) addTask(task);
      }
    } else {
      for (const task of grouped.active) addTask(task);
      for (const task of grouped.done) addTask(task);
    }
    if (showArchived) {
      for (const task of grouped.archived) addTask(task);
    }
    return parts.join("|");
  }, [displaySections, grouped, hasGroups, showArchived, taskIndicators]);
  const taskListScopeRef = useRef<HTMLDivElement>(null);
  const unreadTaskEdges = useUnreadTaskEdges({
    scopeRef: taskListScopeRef,
    disabled: !!activeDragTask,
    refreshKey: unreadTaskEdgeRefreshKey,
  });

  const renderGroup = (label: string, items: Task[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label}>
        <div className="px-3 py-1.5 text-xs font-semibold tracking-wide text-text-secondary">
          {label} ({items.length})
        </div>
        <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {items.map((task) => (
            <SortableTaskItem
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
    <div ref={taskListScopeRef} className={className ?? "flex-1 overflow-y-auto p-2 space-y-2"}>
      <button
        onClick={() => onNewTask()}
        className={`${UI.button.primary} w-full`}
      >
        + New Task
      </button>
      <UnreadTaskEdgePill edge={unreadTaskEdges.above} direction="above" onJump={unreadTaskEdges.jumpToTask} />
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
                {group && (
                <div className="flex items-center">
                  <button
                    onClick={() => {
                      if (onUpdateGroup) onUpdateGroup(group.id, { collapsed: !isCollapsed });
                    }}
                    className="flex-1 px-3 py-1.5 text-xs font-semibold tracking-wide text-text-secondary flex items-center gap-1.5"
                  >
                    {isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                    {group.name}
                  </button>
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
                )}
                {!isCollapsed && (
                  <SortableContext items={section.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                    {section.tasks.map((task) => (
                      <SortableTaskItem
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
            {renderGroup("Done", grouped.done)}
          </>
        )}
        <TaskDragOverlay task={activeDragTask} lastActivity={activeDragTask ? taskIndicators.get(activeDragTask.id)?.lastActivity : undefined} />
      </DndContext>
      {grouped.archived.length > 0 && (
        <>
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="w-full px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors flex items-center gap-1"
          >
            {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />} Closed ({grouped.archived.length})
          </button>
          {showArchived && renderGroup("Closed", grouped.archived)}
        </>
      )}
      {tasks.length === 0 && (
        <EmptyState
          message="No tasks yet"
          sub="Create one to get started"
        />
      )}
      <UnreadTaskEdgePill edge={unreadTaskEdges.below} direction="below" onJump={unreadTaskEdges.jumpToTask} />

      {/* Task context menu */}
      {ctxMenu && ctxTask && (
        <TaskContextMenu
          task={ctxTask}
          position={ctxMenu}
          taskGroups={taskGroups}
          sessionMap={sessionMap}
          isUnread={isUnread}
          activeSessionId={activeSessionId}
          actions={{ markRead, onUpdateTask, onDeleteTask, onMoveTaskToGroup, onCreateGroup }}
          onClose={closeMenu}
        />
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
