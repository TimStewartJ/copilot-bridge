import { useState, useMemo, useCallback } from "react";
import type { Task, TaskGroup, Session } from "../api";
import { GROUP_COLORS, GROUP_COLOR_DOT, GROUP_COLOR_BG } from "../group-colors";
import { Sparkles, MessageSquare, Plus, Settings, PanelLeftClose, PanelLeftOpen, Copy, Check, Play, Pause, CheckCircle, Archive, ArchiveRestore, Trash2, Eye, ChevronDown, ChevronRight, GripVertical, FolderOpen, Palette, Pencil, FolderMinus } from "lucide-react";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
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

interface TaskRailProps {
  tasks: Task[];
  taskGroups?: TaskGroup[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  onSelectQuickChats: () => void;
  isQuickChatsActive: boolean;
  onGoHome: () => void;
  onOpenSettings: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  sessions?: Session[];
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => void;
  onDeleteTask?: (taskId: string) => void;
  onReorderTasks?: (taskIds: string[]) => void;
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed">>) => void;
  onDeleteGroup?: (groupId: string) => void;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onMoveAndReorder?: (taskId: string, groupId: string | undefined, taskIds: string[]) => void;
}

const STATUS_ORDER: Record<Task["status"], number> = {
  active: 0,
  paused: 1,
  done: 2,
  archived: 3,
};

const STATUS_BG: Record<Task["status"], string> = {
  active: "bg-accent/15",
  paused: "bg-warning/15",
  done: "bg-success/15",
  archived: "bg-text-faint/10",
};

const STATUS_TEXT: Record<Task["status"], string> = {
  active: "text-success",
  paused: "text-warning",
  done: "text-text-muted",
  archived: "text-text-faint",
};




function timeAgo(iso?: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function TaskRail({
  tasks,
  taskGroups = [],
  activeTaskId,
  onSelectTask,
  onNewTask,
  onSelectQuickChats,
  isQuickChatsActive,
  onGoHome,
  onOpenSettings,
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
}: TaskRailProps) {
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

  // Busy sessions excluded from unread — unread only fires after idle
  const taskIndicators = useMemo(() => {
    const indicators = new Map<string, { busy: boolean; unread: boolean }>();
    for (const task of tasks) {
      let hasBusy = false;
      let hasUnread = false;
      for (const sid of task.sessionIds) {
        const session = sessionMap.get(sid);
        if (!session || session.archived) continue;
        if (session.busy) { hasBusy = true; continue; }
        if (isUnread?.(sid, session.modifiedTime)) hasUnread = true;
      }
      indicators.set(task.id, { busy: hasBusy, unread: hasUnread });
    }
    return indicators;
  }, [tasks, sessionMap, isUnread]);

  const sortedTasks = useMemo(
    () =>
      [...tasks]
        .filter((t) => t.status !== "archived")
        .sort((a, b) => {
          const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          if (statusDiff !== 0) return statusDiff;
          return a.order - b.order;
        }),
    [tasks],
  );

  const archivedTasks = useMemo(
    () =>
      [...tasks]
        .filter((t) => t.status === "archived")
        .sort((a, b) => a.order - b.order),
    [tasks],
  );

  // Grouped tasks — only when groups exist
  const hasGroups = taskGroups.length > 0;

  const groupedSections = useMemo(() => {
    if (!hasGroups) return null;
    const nonArchived = sortedTasks;
    const sections: { group: TaskGroup | null; tasks: Task[] }[] = [];

    // One section per group (in group order)
    for (const group of taskGroups) {
      sections.push({
        group,
        tasks: nonArchived.filter((t) => t.groupId === group.id),
      });
    }

    // Ungrouped section
    const ungrouped = nonArchived.filter((t) => !t.groupId || !taskGroups.some((g) => g.id === t.groupId));
    if (ungrouped.length > 0) {
      sections.push({ group: null, tasks: ungrouped });
    }

    return sections;
  }, [hasGroups, sortedTasks, taskGroups]);

  const [showArchived, setShowArchived] = useState(false);

  // Context menu state
  const { bind: bindLongPress, menu: ctxMenu, closeMenu: rawCloseMenu, isTarget } = useLongPressMenu<string>();
  const [copied, setCopied] = useState(false);
  const closeMenu = useCallback(() => { rawCloseMenu(); setCopied(false); }, [rawCloseMenu]);

  const ctxTask = ctxMenu ? tasks.find((t) => t.id === ctxMenu.id) : null;

  // Group context menu state
  const [groupCtx, setGroupCtx] = useState<{ groupId: string; x: number; y: number } | null>(null);

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

  const ctxUnreadCount = useMemo(() => {
    if (!ctxTask || !isUnread) return 0;
    return ctxTask.sessionIds.filter((sid) => {
      const session = sessionMap.get(sid);
      return session && !session.archived && isUnread(sid, session.modifiedTime);
    }).length;
  }, [ctxTask, sessionMap, isUnread]);

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
                        title={task.title}
                        className={`relative w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0 transition-colors cursor-pointer ${STATUS_BG[task.status]} ${isActive ? "ring-2 ring-accent" : ""} ${indicator?.unread && indicator?.busy ? "ring-2 ring-success/50" : ""} text-text-primary hover:brightness-110`}
                      >
                        {initials}
                        {indicator?.busy && (
                          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-info animate-pulse ring-2 ring-bg-secondary" />
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
                  title={task.title}
                  className={`relative w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0 transition-colors cursor-pointer ${STATUS_BG[task.status]} ${isActive ? "ring-2 ring-accent" : ""} ${indicator?.unread && indicator?.busy ? "ring-2 ring-success/50" : ""} text-text-primary hover:brightness-110`}
                >
                  {initials}
                  {indicator?.busy && (
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-info animate-pulse ring-2 ring-bg-secondary" />
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
                    title={task.title}
                    className={`relative w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0 transition-colors cursor-pointer ${STATUS_BG[task.status]} ${isActive ? "ring-2 ring-accent" : ""} text-text-primary hover:brightness-110 opacity-60`}
                  >
                    {initials}
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* Quick Chats + New Task */}
        <div className="flex flex-col items-center gap-2 py-2">
          <button
            onClick={onSelectQuickChats}
            title="Quick Chats"
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${isQuickChatsActive ? "bg-bg-hover text-text-primary" : "text-text-muted hover:bg-bg-hover hover:text-text-primary"}`}
          >
            <MessageSquare size={18} />
          </button>
          <button
            onClick={onNewTask}
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

      {/* New Task button */}
      <div className="px-2 pt-2">
        <button
          onClick={onNewTask}
          className="w-full px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors"
        >
          + New Task
        </button>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
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
                      {/* Group header */}
                      <button
                        onClick={() => {
                          if (group && onUpdateGroup) {
                            onUpdateGroup(group.id, { collapsed: !isCollapsed });
                          }
                        }}
                        onContextMenu={(e) => {
                          if (group) {
                            e.preventDefault();
                            setGroupCtx({ groupId: group.id, x: e.clientX, y: e.clientY });
                          }
                        }}
                        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors cursor-pointer group/header"
                      >
                        {group ? (
                          isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />
                        ) : null}
                        <span className="font-medium truncate">{group?.name ?? "Ungrouped"}</span>
                        <span className="text-text-faint ml-auto text-[10px]">{section.tasks.length}</span>
                      </button>

                      {/* Group tasks */}
                      {!isCollapsed && (
                        <SortableContext items={section.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                          {section.tasks.map((task) => (
                            <SortableRailItem
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
              })}
            </>
          ) : (
            // ── Flat mode (no groups) ──────────────────────────
            <SortableContext items={sortedTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {sortedTasks.map((task) => (
                <SortableRailItem
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
          <DragOverlay dropAnimation={null}>
            {activeDragTask ? (
              <div className="bg-bg-secondary rounded-md shadow-lg border border-border px-3 py-2 text-sm w-48 opacity-90">
                <div className="font-medium truncate">{activeDragTask.title}</div>
                <div className="text-xs text-text-muted mt-0.5">{timeAgo(activeDragTask.updatedAt)}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        {sortedTasks.length === 0 && (
          <div className="text-center text-text-muted text-xs py-6">
            No tasks yet
          </div>
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
              const linkCount =
                task.sessionIds.length +
                task.workItems.length +
                task.pullRequests.length;

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
                    <span className="text-[10px] text-text-faint">archived</span>
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {timeAgo(task.updatedAt)}
                    {linkCount > 0 && ` · ${linkCount} linked`}
                  </div>
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* Quick Chats */}
      <div className="px-2 pb-1">
        <button
          onClick={onSelectQuickChats}
          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 ${
            isQuickChatsActive
              ? "bg-bg-hover text-text-primary"
              : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
          }`}
        >
          <MessageSquare size={14} />
          Quick Chats
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
        <ContextMenu position={ctxMenu} onClose={closeMenu}>
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
          {onUpdateTask && ctxTask.status !== "active" && (
            <CtxItem icon={<Play size={14} />} label="Set Active"
              onClick={() => { onUpdateTask(ctxTask.id, { status: "active" }); closeMenu(); }} />
          )}
          {onUpdateTask && ctxTask.status !== "paused" && ctxTask.status !== "archived" && (
            <CtxItem icon={<Pause size={14} />} label="Set Paused"
              onClick={() => { onUpdateTask(ctxTask.id, { status: "paused" }); closeMenu(); }} />
          )}
          {onUpdateTask && ctxTask.status !== "done" && ctxTask.status !== "archived" && (
            <CtxItem icon={<CheckCircle size={14} />} label="Set Done"
              onClick={() => { onUpdateTask(ctxTask.id, { status: "done" }); closeMenu(); }} />
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
          {onDeleteTask && (
            <>
              <CtxDivider />
              <CtxItem icon={<Trash2 size={14} />} label="Delete" className="text-error"
                onClick={() => { onDeleteTask(ctxTask.id); closeMenu(); }} />
            </>
          )}
        </ContextMenu>
      )}

      {/* Group context menu */}
      {groupCtx && (() => {
        const group = taskGroups.find((g) => g.id === groupCtx.groupId);
        if (!group) return null;
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
    </div>
  );
}

// ── Sortable task item for expanded rail ──────────────────────────

function SortableRailItem({
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
        className={`w-full text-left px-3 py-2 rounded-md text-sm select-none no-callout transition-all duration-150 ${
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
          <span className={`text-[10px] ml-1 ${STATUS_TEXT[task.status]}`}>
            {task.status !== "active" ? task.status : ""}
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