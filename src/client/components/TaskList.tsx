import { useState, useMemo, useEffect, useRef } from "react";
import { type Task, type TaskGroup, type Session, type TaskPatch } from "../api";
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown, Plus, FileText } from "lucide-react";
import NotesSheet from "./NotesSheet";
import EmptyState from "./shared/EmptyState";
import useLongPressMenu from "../hooks/useLongPressMenu";
import useTaskIndicators from "../hooks/useTaskIndicators";
import useCrossGroupDnd from "../hooks/useCrossGroupDnd";
import { groupTasksByStatus, buildGroupSections, isSetAsideTask, mergeVisibleOrder } from "../task-helpers";
import { useTaskOverviewQuery } from "../hooks/queries/useTaskOverview";
import { needsYouCount, setAsideAttention } from "../lib/task-state-ui";
import { SortableTaskItem, DroppableGroup, TaskDragOverlay, TaskContextMenu, TaskReorderBar, UnreadTaskEdgePill, useTaskReorderMode, useUnreadTaskEdges } from "./task-list";
import { DS, cx } from "../design/tokens";
import { Button, IdentitySwatch, StatusIcon } from "../design/primitives";
import { DndContext } from "@dnd-kit/core";
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

  const { bind: bindLongPress, menu: ctxMenu, closeMenu, isTarget, resetClickGuard } = useLongPressMenu<string>();
  const ctxTask = ctxMenu ? tasks.find((t) => t.id === ctxMenu.id) : null;

  const statusGroups = useMemo(() => groupTasksByStatus(tasks), [tasks]);
  // Deferred and muted tasks sit in a collapsed Set aside section, out of the reorderable list.
  const grouped = useMemo(() => ({
    active: statusGroups.active.filter((task) => !isSetAsideTask(task)),
    setAside: statusGroups.active.filter(isSetAsideTask),
    archived: statusGroups.archived,
  }), [statusGroups]);
  const setAsideIds = useMemo(() => new Set(grouped.setAside.map((task) => task.id)), [grouped]);
  const reorderVisible = useMemo(() => onReorderTasks
    ? (ids: string[]) => onReorderTasks(mergeVisibleOrder(statusGroups.active, setAsideIds, ids))
    : undefined, [onReorderTasks, setAsideIds, statusGroups]);
  const moveAndReorderVisible = useMemo(() => onMoveAndReorder
    ? (taskId: string, groupId: string | undefined, ids: string[]) => onMoveAndReorder(taskId, groupId, mergeVisibleOrder(statusGroups.active, setAsideIds, ids, groupId ?? null))
    : undefined, [onMoveAndReorder, setAsideIds, statusGroups]);
  const overview = useTaskOverviewQuery();
  const quietIds = useMemo(() => new Set((overview.data?.tasks ?? []).filter((row) => row.state === "gone_quiet").map((row) => row.id)), [overview.data]);
  const setAsideNeeds = useMemo(() => setAsideAttention(overview.data?.tasks, setAsideIds), [overview.data, setAsideIds]);
  const [showArchived, setShowArchived] = useState(false);
  const [showSetAside, setShowSetAside] = useState(false);
  useEffect(() => {
    if (activeTaskId && setAsideIds.has(activeTaskId)) setShowSetAside(true);
  }, [activeTaskId, setAsideIds]);

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
    return buildGroupSections(grouped.active, taskGroups);
  }, [hasGroups, grouped, taskGroups]);

  const {
    sensors,
    activeDragTask,
    displaySections,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    collisionDetection,
  } = useCrossGroupDnd({
    tasks: grouped.active,
    groupedSections,
    hasGroups,
    onReorderTasks: reorderVisible,
    onMoveTaskToGroup,
    onMoveAndReorder: moveAndReorderVisible,
  });
  const newTaskButtonRef = useRef<HTMLButtonElement>(null);
  const canReorder = Boolean(onReorderTasks) && grouped.active.length >= 2;
  const reorderMode = useTaskReorderMode({
    enabled: canReorder,
    dragging: Boolean(activeDragTask),
    onExit: resetClickGuard,
    returnFocusRef: newTaskButtonRef,
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

  const renderGroup = (label: string, items: Task[], sortable = false) => {
    if (items.length === 0) return null;
    return (
      <div key={label} className={cx(DS.surface.group, "overflow-hidden")} data-ds-surface="group">
        <div className={cx(DS.collection.header, "px-3 text-xs font-medium text-text-secondary")}>
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
              quiet={quietIds.has(task.id)}
              reordering={sortable && reorderMode.reordering}
            />
          ))}
        </SortableContext>
      </div>
    );
  };

  return (
    <div ref={taskListScopeRef} className={className ?? "flex-1 overflow-y-auto p-2 space-y-2"}>
      <Button ref={newTaskButtonRef} fullWidth icon={<Plus size={14} aria-hidden="true" />} onClick={() => onNewTask()}>
        New task
      </Button>
      {reorderMode.reordering && <TaskReorderBar onDone={reorderMode.stop} />}
      <UnreadTaskEdgePill edge={unreadTaskEdges.above} direction="above" onJump={unreadTaskEdges.jumpToTask} />
      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
        {hasGroups && displaySections ? (
          displaySections.map((section) => {
            const group = section.group;
            const isCollapsed = group?.collapsed ?? false;
            const groupId = group?.id ?? "__ungrouped__";
            return (
              <DroppableGroup key={groupId} id={groupId}>
                <div className={cx(DS.surface.group, "overflow-hidden")} data-ds-surface="group">
                {group && (
                <div className={DS.collection.header}>
                  <button
                    onClick={() => {
                      if (onUpdateGroup) onUpdateGroup(group.id, { collapsed: !isCollapsed });
                    }}
                    aria-expanded={!isCollapsed}
                    className={cx(DS.focus, "flex min-h-10 min-w-0 flex-1 items-center gap-1.5 px-3 text-xs font-medium text-text-secondary md:min-h-8")}
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <IdentitySwatch color={group.color} />
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
                        quiet={quietIds.has(task.id)}
                        reordering={reorderMode.reordering}
                      />
                    ))}
                  </SortableContext>
                )}
                </div>
              </DroppableGroup>
            );
          })
        ) : (
          renderGroup("Active", grouped.active, true)
        )}
        <TaskDragOverlay task={activeDragTask} lastActivity={activeDragTask ? taskIndicators.get(activeDragTask.id)?.lastActivity : undefined} />
      </DndContext>
      {grouped.setAside.length > 0 && (
        <>
          <button
            onClick={() => setShowSetAside(!showSetAside)}
            aria-expanded={showSetAside}
            className="w-full whitespace-nowrap px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1"
          >
            {showSetAside ? <ChevronDown size={10} /> : <ChevronRight size={10} />} Set aside ({grouped.setAside.length})
            {setAsideNeeds.size > 0 && (
              <span className={cx("ml-1 inline-flex items-center gap-1 font-medium", DS.tone.warning)}>
                <StatusIcon kind="warning" decorative />
                {needsYouCount(setAsideNeeds.size)}
              </span>
            )}
          </button>
          {showSetAside && renderGroup("Set aside", grouped.setAside)}
        </>
      )}
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
          actions={{
            markRead,
            onUpdateTask,
            onDeleteTask,
            onMoveTaskToGroup,
            onCreateGroup,
            onStartReorder: canReorder && !reorderMode.reordering ? reorderMode.start : undefined,
          }}
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
