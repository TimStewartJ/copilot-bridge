import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { type Task, type TaskGroup, type Session, type TaskPatch } from "../api";
import { GROUP_COLORS, GROUP_COLOR_DOT, GROUP_COLOR_BG } from "../group-colors";
import { timeAgo } from "../time";
import { describeHomeChecklistIndicator, type HomeChecklistIndicator } from "../checklist-helpers";
import { Sparkles, MessageSquare, Plus, Settings, PanelLeftClose, PanelLeftOpen, Archive, ChevronDown, ChevronRight, FolderOpen, Palette, Pencil, FolderMinus, ArrowUp, ArrowDown, BookOpen, LayoutDashboard, Tag, FileText, ListTodo, Trash2, Pin } from "lucide-react";
import TagPicker from "./TagPicker";
import { TagPillList } from "./TagPill";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
import NotesSheet from "./NotesSheet";
import EmptyState from "./shared/EmptyState";
import SessionList from "./SessionList";
import useLongPressMenu from "../hooks/useLongPressMenu";
import useTaskIndicators, { countChatTabUnread, countTaskTabUnread } from "../hooks/useTaskIndicators";
import useCrossGroupDnd from "../hooks/useCrossGroupDnd";
import { splitArchivedTasks, buildGroupSections } from "../task-helpers";
import { SortableTaskItem, DroppableGroup, TaskDragOverlay, TaskContextMenu, UnreadTaskEdgePill, useUnreadTaskEdges } from "./task-list";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import TaskKindBadge from "./TaskKindBadge";
import { getTaskKindLabel } from "../task-kind";
import { UI } from "./shared/design-system";

interface TaskRailProps {
  tasks: Task[];
  taskGroups?: TaskGroup[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: (groupId?: string) => void;
  isQuickChatsActive: boolean;
  onGoHome: () => void;
  onOpenSettings: () => void;
  onOpenDocs: () => void;
  isDocsActive: boolean;
  isDashboardActive: boolean;
  homeChecklistIndicator?: HomeChecklistIndicator;
  expanded: boolean;
  onToggleExpanded: () => void;
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
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>) => void;
  onDeleteGroup?: (groupId: string) => void;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onMoveAndReorder?: (taskId: string, groupId: string | undefined, taskIds: string[]) => void;
  onReorderGroups?: (groupIds: string[]) => void;
  onSetGroupTags?: (groupId: string, tagIds: string[]) => void;
  // Inline quick chats
  orphanSessions?: Session[];
  activeSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  onNewQuickChat?: () => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  onDeleteSession?: (sessionId: string) => void;
  onForkSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  onLinkToTask?: (sessionId: string, taskId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  onMarkAllQuickChatsRead?: () => void;
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  archivedLoading?: boolean;
  archivingIds?: Set<string>;
  exitingIds?: Set<string>;
  hasDraft?: (sessionId: string) => boolean;
  onBulkAction?: (action: import("../api").BatchAction, sessionIds: string[]) => void;
  onRailTabChange?: (tab: "tasks" | "chats") => void;
}

const STATUS_BG: Record<Task["status"], string> = {
  active: "bg-info-surface",
  done: "bg-success/15",
  archived: "bg-text-faint/10",
};

function getTaskTitle(task: Task): string {
  const suffixes = [];
  if (task.kind === "ongoing") suffixes.push(getTaskKindLabel(task.kind).toLowerCase());
  if (task.muted) suffixes.push("muted");
  return suffixes.length > 0 ? `${task.title} · ${suffixes.join(" · ")}` : task.title;
}


export default function TaskRail({
  tasks,
  taskGroups = [],
  activeTaskId,
  onSelectTask,
  onNewTask,
  isQuickChatsActive,
  onGoHome,
  onOpenSettings,
  onOpenDocs,
  isDocsActive,
  isDashboardActive,
  homeChecklistIndicator = { state: "none", dueTodayCount: 0, overdueCount: 0, urgentCount: 0 },
  expanded,
  onToggleExpanded,
  sessions = [],
  isUnread,
  markRead,
  onUpdateTask,
  onDeleteTask,
  onReorderTasks,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onMoveTaskToGroup,
  onMoveAndReorder,
  onReorderGroups,
  onSetGroupTags,
  orphanSessions = [],
  activeSessionId,
  onSelectSession,
  onNewQuickChat,
  onArchiveSession,
  onDeleteSession,
  onForkSession,
  onReloadSession,
  onLinkToTask,
  onMarkUnread,
  onMarkAllQuickChatsRead,
  onRequestArchived,
  archivedLoaded,
  archivedLoading,
  archivingIds,
  exitingIds,
  hasDraft,
  onBulkAction,
  onRailTabChange,
}: TaskRailProps) {
  const navBtn = (active: boolean) =>
    active ? `${UI.surface.selectedRow} text-accent` : "text-text-muted hover:bg-bg-hover hover:text-text-primary";
  const homeIndicatorDescription = describeHomeChecklistIndicator(homeChecklistIndicator);
  const homeIndicatorDotClass = homeChecklistIndicator.state === "overdue"
    ? "bg-error"
    : homeChecklistIndicator.state === "due-today"
      ? "bg-warning"
      : "";

  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

  const taskIndicators = useTaskIndicators(tasks, sessions, isUnread, activeSessionId);

  const { nonArchived: sortedTasks, archived: archivedTasks } = useMemo(
    () => splitArchivedTasks(tasks),
    [tasks],
  );

  // Grouped tasks — only when groups exist
  const hasGroups = taskGroups.length > 0;

  const groupedSections = useMemo(() => {
    if (!hasGroups) return null;
    return buildGroupSections(sortedTasks, taskGroups);
  }, [hasGroups, sortedTasks, taskGroups]);

  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (tasks.some((task) => task.id === activeTaskId && task.status === "archived")) {
      setShowArchived(true);
    }
  }, [activeTaskId, tasks]);

  // Tab state for expanded rail
  const [railTab, setRailTab] = useState<"tasks" | "chats">("tasks");

  // Sync tab with route: if a quick chat is active → chats tab; if a task is active → tasks tab
  useEffect(() => {
    if (isQuickChatsActive || (activeSessionId && !activeTaskId)) {
      setRailTab("chats");
    } else if (activeTaskId) {
      setRailTab("tasks");
    }
  }, [isQuickChatsActive, activeSessionId, activeTaskId]);

  // Badge counts for tabs (unread only — busy resolves to unread naturally)
  const taskTabUnread = useMemo(() => {
    return countTaskTabUnread(tasks, taskIndicators);
  }, [tasks, taskIndicators]);

  const chatTabUnread = useMemo(() => countChatTabUnread(orphanSessions, isUnread), [orphanSessions, isUnread]);

  // Context menu state (tasks)
  const { bind: bindLongPress, menu: ctxMenu, closeMenu, isTarget } = useLongPressMenu<string>();
  const ctxTask = ctxMenu ? tasks.find((t) => t.id === ctxMenu.id) : null;

  // Group context menu state
  const [groupCtx, setGroupCtx] = useState<{ groupId: string; x: number; y: number } | null>(null);

  // Group notes sheet state
  const [groupNotesId, setGroupNotesId] = useState<string | null>(null);
  const [groupNotesStartEdit, setGroupNotesStartEdit] = useState(false);

  // DnD setup
  const {
    sensors,
    activeDragTask,
    displaySections,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  } = useCrossGroupDnd({
    tasks: sortedTasks,
    groupedSections,
    hasGroups,
    onReorderTasks,
    onMoveTaskToGroup,
    onMoveAndReorder,
  });
  const unreadTaskEdgeRefreshKey = useMemo(() => {
    const parts: string[] = [expanded ? "expanded" : "collapsed", railTab, showArchived ? "archived" : "open"];
    const addTask = (task: Task) => {
      parts.push(`${task.id}:${taskIndicators.get(task.id)?.unread ? "1" : "0"}`);
    };
    if (hasGroups && displaySections) {
      for (const section of displaySections) {
        if (section.group?.collapsed) continue;
        for (const task of section.tasks) addTask(task);
      }
    } else {
      for (const task of sortedTasks) addTask(task);
    }
    return parts.join("|");
  }, [displaySections, expanded, hasGroups, railTab, showArchived, sortedTasks, taskIndicators]);
  const expandedTaskListRef = useRef<HTMLDivElement>(null);
  const unreadTaskEdges = useUnreadTaskEdges({
    scopeRef: expandedTaskListRef,
    scrollContainerRef: expandedTaskListRef,
    disabled: !expanded || railTab !== "tasks" || !!activeDragTask,
    refreshKey: unreadTaskEdgeRefreshKey,
  });

  // ── Collapsed (icon-only) mode ─────────────────────────────────
  if (!expanded) {
    return (
      <div className="hidden md:flex flex-col h-full w-14 shrink-0 bg-bg-secondary border-r border-border">
        {/* Brand / Home */}
        <div className="flex items-center justify-center py-3">
          <button
            onClick={onGoHome}
            className="p-1.5 rounded-lg text-accent hover:bg-bg-hover transition-colors"
            title="Home"
          >
            <Sparkles size={20} />
          </button>
        </div>

        {/* Task items */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col items-center gap-2 py-2 scrollbar-thin">
          {hasGroups && groupedSections ? (
            // Grouped mode — color dividers between groups
            groupedSections.map((section, si) => {
              const group = section.group;
              const isCollapsed = group?.collapsed ?? false;
              const colorBg = group ? GROUP_COLOR_BG[group.color] ?? "bg-slate-500/8" : undefined;

              return (
                <div key={group?.id ?? "__ungrouped__"} className={`flex flex-col items-center gap-2 w-full ${colorBg ? `${colorBg} rounded-xl py-1.5` : ""}`} title={group?.name}>
                  {!isCollapsed && section.tasks.map((task) => {
                    const isActive = task.id === activeTaskId;
                    const indicator = taskIndicators.get(task.id);
                    const initials = task.title.slice(0, 2).toUpperCase();

                    return (
                      <button
                        key={task.id}
                        onClick={() => onSelectTask(task.id)}
                        title={getTaskTitle(task)}
                        className={`relative w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0 transition-colors cursor-pointer ${STATUS_BG[task.status]} ${isActive ? "ring-2 ring-accent" : ""} ${indicator?.unread && indicator?.busy ? "ring-2 ring-success/50" : ""} text-text-primary hover:brightness-110`}
                      >
                        {initials}
                        {task.kind === "ongoing" && (
                          <Pin size={7} className="absolute bottom-0.5 left-0.5 text-accent rotate-45" />
                        )}
                        {indicator?.busy && (
                          <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full animate-pulse ring-2 ring-bg-secondary ${indicator.stalled ? "bg-warning" : "bg-info"}`} />
                        )}
                        {indicator?.unread && !indicator?.busy && (
                          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success ring-2 ring-bg-secondary" />
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          ) : (
            // Flat mode
            sortedTasks.map((task) => {
              const isActive = task.id === activeTaskId;
              const indicator = taskIndicators.get(task.id);
              const initials = task.title.slice(0, 2).toUpperCase();

              return (
                <button
                  key={task.id}
                  onClick={() => onSelectTask(task.id)}
                  title={getTaskTitle(task)}
                  className={`relative w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0 transition-colors cursor-pointer ${STATUS_BG[task.status]} ${isActive ? "ring-2 ring-accent" : ""} ${indicator?.unread && indicator?.busy ? "ring-2 ring-success/50" : ""} text-text-primary hover:brightness-110`}
                >
                  {initials}
                  {task.kind === "ongoing" && (
                    <Pin size={7} className="absolute bottom-0.5 left-0.5 text-accent rotate-45" />
                  )}
                  {indicator?.busy && (
                    <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full animate-pulse ring-2 ring-bg-secondary ${indicator.stalled ? "bg-warning" : "bg-info"}`} />
                  )}
                  {indicator?.unread && !indicator?.busy && (
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success ring-2 ring-bg-secondary" />
                  )}
                </button>
              );
            })
          )}
          {archivedTasks.length > 0 && (
            <>
              <button
                onClick={() => setShowArchived((v) => !v)}
                title={`Archived (${archivedTasks.length})`}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-text-faint hover:bg-bg-hover hover:text-text-muted transition-colors cursor-pointer"
              >
                <Archive size={16} />
              </button>
              {showArchived && archivedTasks.map((task) => {
                const isActive = task.id === activeTaskId;
                const initials = task.title.slice(0, 2).toUpperCase();
                return (
                  <button
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                    title={getTaskTitle(task)}
                    className={`relative w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0 transition-colors cursor-pointer ${STATUS_BG[task.status]} ${isActive ? "ring-2 ring-accent" : ""} text-text-primary hover:brightness-110 opacity-60`}
                  >
                    {initials}
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* Dashboard + Docs + New Task */}
        <div className="flex flex-col items-center gap-2 py-2">
          <button
            onClick={onGoHome}
            title={homeIndicatorDescription ? `Dashboard • ${homeIndicatorDescription}` : "Dashboard"}
            aria-label={homeIndicatorDescription ? `Dashboard, ${homeIndicatorDescription}` : "Dashboard"}
            className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${navBtn(isDashboardActive)}`}
          >
            <LayoutDashboard size={18} />
            {homeChecklistIndicator.state !== "none" && (
              <span
                aria-hidden="true"
                className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-bg-secondary ${homeIndicatorDotClass}`}
              />
            )}
          </button>
          <button
            onClick={onOpenDocs}
            title="Docs"
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${navBtn(isDocsActive)}`}
          >
            <BookOpen size={18} />
          </button>
          <button
            onClick={() => onNewTask()}
            title="New Task"
            className="p-1.5 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            <Plus size={16} />
          </button>
        </div>

        {/* Bottom: expand + settings */}
        <div className="flex flex-col items-center gap-1 py-3 mt-auto">
          <button
            onClick={onToggleExpanded}
            title="Expand task list"
            className="p-1.5 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            <PanelLeftOpen size={16} />
          </button>
          <button
            onClick={onOpenSettings}
            title="Settings"
            className="p-1.5 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>
    );
  }

  // ── Expanded mode ──────────────────────────────────────────────
  return (
    <div className="hidden md:flex flex-col h-full w-56 shrink-0 bg-bg-secondary border-r border-border">
      {/* Header */}
      <div className="px-3 py-3 border-b border-border flex items-center justify-between">
        <button
          onClick={onGoHome}
          className="text-sm font-medium text-text-primary hover:text-accent transition-colors flex items-center gap-1.5"
        >
          <Sparkles size={14} className="text-accent" />
          Copilot Bridge
        </button>
        <button
          onClick={onToggleExpanded}
          title="Collapse task list"
          className="p-1 rounded text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      {/* ── Tab bar ─────────────────────────────────────────── */}
      <div className="flex items-center border-b border-border">
        <button
          onClick={() => { setRailTab("tasks"); onRailTabChange?.("tasks"); }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors relative ${
            railTab === "tasks"
              ? "text-text-primary"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          <ListTodo size={13} />
          Tasks
          {taskTabUnread > 0 && (
            <span className="min-w-[16px] h-4 px-1 rounded-full bg-success text-white text-[10px] font-semibold flex items-center justify-center">
              {taskTabUnread}
            </span>
          )}
          {railTab === "tasks" && (
            <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-accent rounded-full" />
          )}
        </button>
        <button
          onClick={() => { setRailTab("chats"); onRailTabChange?.("chats"); }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors relative ${
            railTab === "chats"
              ? "text-text-primary"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          <MessageSquare size={13} />
          Chats
          {chatTabUnread > 0 && (
            <span className="min-w-[16px] h-4 px-1 rounded-full bg-success text-white text-[10px] font-semibold flex items-center justify-center">
              {chatTabUnread}
            </span>
          )}
          {railTab === "chats" && (
            <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-accent rounded-full" />
          )}
        </button>
      </div>

      {/* ── Tab content (scrollable) ────────────────────────── */}
      <div ref={expandedTaskListRef} className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {railTab === "tasks" ? (
          <>
            {/* New Task button */}
            <button
              onClick={() => onNewTask()}
              className={`${UI.button.primary} mb-1 w-full`}
            >
              + New Task
            </button>
            <UnreadTaskEdgePill edge={unreadTaskEdges.above} direction="above" onJump={unreadTaskEdges.jumpToTask} />

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
              {hasGroups && displaySections ? (
                // ── Grouped mode ──────────────────────────────────
                <>
                  {displaySections.map((section) => {
                    const group = section.group;
                    const isCollapsed = group?.collapsed ?? false;
                    const groupId = group?.id ?? "__ungrouped__";
                    const colorBg = group ? GROUP_COLOR_BG[group.color] ?? "bg-slate-500/8" : undefined;

                    return (
                      <DroppableGroup key={groupId} id={groupId}>
                        <div className={`mb-1 ${colorBg ? `${colorBg} rounded-lg` : ""}`}>
                          {/* Group header (skip for ungrouped tasks) */}
                          {group && (
                          <div className="flex items-center group/header">
                          <button
                            onClick={() => {
                              if (onUpdateGroup) {
                                onUpdateGroup(group.id, { collapsed: !isCollapsed });
                              }
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setGroupCtx({ groupId: group.id, x: e.clientX, y: e.clientY });
                            }}
                            className="flex-1 min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors cursor-pointer"
                          >
                            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                            <span className="font-medium truncate">{group.name}</span>
                          </button>
                            {group.notes && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setGroupNotesId(group.id);
                                  setGroupNotesStartEdit(false);
                                }}
                                title="Group notes"
                                className="p-1 rounded text-text-faint hover:text-text-primary hover:bg-bg-hover transition-all cursor-pointer"
                              >
                                <FileText size={11} />
                              </button>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onNewTask(group.id);
                              }}
                              title={`New task in ${group.name}`}
                              className="p-1 mr-1.5 rounded text-text-faint opacity-0 group-hover/header:opacity-100 hover:text-text-primary hover:bg-bg-hover transition-all cursor-pointer"
                            >
                              <Plus size={12} />
                            </button>
                          </div>
                          )}

                          {/* Group tasks */}
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
                                  variant="rail"
                                />
                              ))}
                            </SortableContext>
                          )}
                        </div>
                      </DroppableGroup>
                    );
                  })}
                </>
              ) : (
                // ── Flat mode (no groups) ──────────────────────────
                <SortableContext items={sortedTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  {sortedTasks.map((task) => (
                    <SortableTaskItem
                      key={task.id}
                      task={task}
                      isActive={task.id === activeTaskId}
                      indicator={taskIndicators.get(task.id)}
                      isCtxTarget={ctxMenu?.id === task.id}
                      isLongPressTarget={isTarget(task.id)}
                      bindLongPress={bindLongPress}
                      onSelectTask={onSelectTask}
                      variant="rail"
                    />
                  ))}
                </SortableContext>
              )}
              <TaskDragOverlay task={activeDragTask} lastActivity={activeDragTask ? taskIndicators.get(activeDragTask.id)?.lastActivity : undefined} />
            </DndContext>
            {sortedTasks.length === 0 && (
              <EmptyState
                message="No tasks yet"
                sub="Create a task to organize your work"
              />
            )}
            {archivedTasks.length > 0 && (
              <>
                <button
                  onClick={() => setShowArchived((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 mt-2 text-xs text-text-faint hover:text-text-muted transition-colors cursor-pointer"
                >
                  {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Archive size={12} />
                  Archived ({archivedTasks.length})
                </button>
                {showArchived && archivedTasks.map((task) => {
                  const isActive = task.id === activeTaskId;

                  return (
                    <button
                      key={task.id}
                      {...bindLongPress(task.id, () => onSelectTask(task.id))}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm select-none no-callout transition-all duration-150 opacity-60 ${
                        ctxMenu?.id === task.id
                          ? "bg-bg-hover ring-1 ring-border"
                          : isActive
                            ? "bg-bg-hover"
                            : "hover:bg-bg-hover"
                      } ${isTarget(task.id) ? "scale-[0.97] bg-bg-hover" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate flex-1">
                          {task.title}
                        </span>
                        <TaskKindBadge kind={task.kind} iconOnly className="shrink-0" />
                        <span className="text-[10px] text-text-faint">archived</span>
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        {timeAgo(taskIndicators.get(task.id)?.lastActivity ?? task.updatedAt)}
                      </div>
                    </button>
                  );
                })}
              </>
            )}
            <UnreadTaskEdgePill edge={unreadTaskEdges.below} direction="below" onJump={unreadTaskEdges.jumpToTask} />
          </>
        ) : (
          <SessionList
            variant="compact"
            sessions={orphanSessions}
            activeSessionId={activeSessionId ?? null}
            onSelectSession={(sessionId) => onSelectSession?.(sessionId)}
            onNewSession={() => onNewQuickChat?.()}
            newButtonLabel="+ Quick Chat"
            isUnread={isUnread}
            onArchiveSession={onArchiveSession}
            archivingIds={archivingIds}
            exitingIds={exitingIds}
            tasks={tasks}
            onLinkToTask={onLinkToTask}
            onDeleteSession={onDeleteSession}
            onForkSession={onForkSession}
            onReloadSession={onReloadSession}
            onMarkUnread={onMarkUnread}
            onMarkAllRead={onMarkAllQuickChatsRead}
            hasDraft={hasDraft}
            onBulkAction={onBulkAction}
            onRequestArchived={onRequestArchived}
            archivedLoaded={archivedLoaded}
            archivedLoading={archivedLoading}
          />
        )}
      </div>

      {/* Dashboard */}
      <div className="px-2 pb-1">
        <button
          onClick={onGoHome}
          title={homeIndicatorDescription ? `Dashboard • ${homeIndicatorDescription}` : "Dashboard"}
          aria-label={homeIndicatorDescription ? `Dashboard, ${homeIndicatorDescription}` : "Dashboard"}
          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 ${navBtn(isDashboardActive)}`}
        >
          <LayoutDashboard size={14} />
          Dashboard
          {homeChecklistIndicator.state !== "none" && (
            <span
              aria-hidden="true"
              className={`ml-auto h-2.5 w-2.5 rounded-full ${homeIndicatorDotClass}`}
            />
          )}
        </button>
      </div>

      {/* Docs */}
      <div className="px-2 pb-1">
        <button
          onClick={onOpenDocs}
          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 ${navBtn(isDocsActive)}`}
        >
          <BookOpen size={14} />
          Docs
        </button>
      </div>

      {/* Settings */}
      <div className="px-2 py-2 border-t border-border">
        <button
          onClick={onOpenSettings}
          className="w-full text-left px-3 py-1.5 rounded-md text-xs text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors flex items-center gap-2"
        >
          <Settings size={14} />
          Settings
        </button>
      </div>

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

      {/* Group context menu */}
      {groupCtx && (() => {
        const group = taskGroups.find((g) => g.id === groupCtx.groupId);
        if (!group) return null;
        const groupIndex = taskGroups.indexOf(group);
        const isFirst = groupIndex === 0;
        const isLast = groupIndex === taskGroups.length - 1;
        return (
          <ContextMenu position={{ x: groupCtx.x, y: groupCtx.y }} onClose={() => setGroupCtx(null)}>
            <CtxItem
              icon={<Pencil size={14} />}
              label="Rename"
              onClick={() => {
                setGroupCtx(null);
                const name = window.prompt("Group name:", group.name);
                if (name?.trim() && name.trim() !== group.name && onUpdateGroup) {
                  onUpdateGroup(group.id, { name: name.trim() });
                }
              }}
            />
            <CtxItem
              icon={<FileText size={14} />}
              label={group.notes ? "Edit Notes" : "Add Notes"}
              onClick={() => {
                setGroupCtx(null);
                setGroupNotesId(group.id);
                setGroupNotesStartEdit(!group.notes);
              }}
            />
            {/* Color picker */}
            <div className="px-3 py-1.5">
              <div className="text-[10px] text-text-faint mb-1 flex items-center gap-1">
                <Palette size={10} /> Color
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {GROUP_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      if (onUpdateGroup && c !== group.color) onUpdateGroup(group.id, { color: c });
                      setGroupCtx(null);
                    }}
                    className={`w-4 h-4 rounded-full ${GROUP_COLOR_DOT[c]} transition-all ${c === group.color ? "ring-2 ring-white ring-offset-1 ring-offset-bg-elevated scale-110" : "hover:scale-110"}`}
                  />
                ))}
              </div>
            </div>
            {/* Group tags */}
            {onSetGroupTags && (
              <>
                <CtxDivider />
                <div className="px-3 py-1.5">
                  <div className="text-[10px] text-text-faint mb-1 flex items-center gap-1">
                    <Tag size={10} /> Tags
                  </div>
                  <div className="flex flex-wrap gap-1 items-center">
                    <TagPillList
                      tags={group.tags ?? []}
                      size="xs"
                      onRemove={(tagId) => {
                        const currentIds = (group.tags ?? []).map((t) => t.id);
                        onSetGroupTags(group.id, currentIds.filter((id) => id !== tagId));
                      }}
                    />
                    <TagPicker
                      selectedTagIds={(group.tags ?? []).map((t) => t.id)}
                      onChange={(tagIds) => onSetGroupTags(group.id, tagIds)}
                      compact
                    />
                  </div>
                </div>
              </>
            )}
            {taskGroups.length > 1 && onReorderGroups && (
              <>
                <CtxDivider />
                <CtxItem
                  icon={<ArrowUp size={14} />}
                  label="Move Up"
                  disabled={isFirst}
                  onClick={() => {
                    if (isFirst) return;
                    const ids = taskGroups.map((g) => g.id);
                    [ids[groupIndex - 1], ids[groupIndex]] = [ids[groupIndex], ids[groupIndex - 1]];
                    onReorderGroups(ids);
                    setGroupCtx(null);
                  }}
                />
                <CtxItem
                  icon={<ArrowDown size={14} />}
                  label="Move Down"
                  disabled={isLast}
                  onClick={() => {
                    if (isLast) return;
                    const ids = taskGroups.map((g) => g.id);
                    [ids[groupIndex], ids[groupIndex + 1]] = [ids[groupIndex + 1], ids[groupIndex]];
                    onReorderGroups(ids);
                    setGroupCtx(null);
                  }}
                />
              </>
            )}
            <CtxDivider />
            <CtxItem
              icon={<Trash2 size={14} />}
              label="Delete Group"
              className="text-error"
              onClick={() => {
                if (onDeleteGroup) onDeleteGroup(group.id);
                setGroupCtx(null);
              }}
            />
          </ContextMenu>
        );
      })()}

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
