import { useState, useMemo, useCallback, useRef } from "react";
import type { Task, Session } from "../api";
import { Sparkles, MessageSquare, Plus, Settings, PanelLeftClose, PanelLeftOpen, Copy, Check, Play, Pause, CheckCircle, Archive, ArchiveRestore, Trash2, Eye, ChevronDown, ChevronRight } from "lucide-react";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";

interface TaskRailProps {
  tasks: Task[];
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
}: TaskRailProps) {
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

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

  const sortedTasks = useMemo(
    () =>
      [...tasks]
        .filter((t) => t.status !== "archived")
        .sort((a, b) => {
          const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          if (statusDiff !== 0) return statusDiff;
          return (
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
        }),
    [tasks],
  );

  const archivedTasks = useMemo(
    () =>
      [...tasks]
        .filter((t) => t.status === "archived")
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [tasks],
  );

  const [showArchived, setShowArchived] = useState(false);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; taskId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const closeMenu = useCallback(() => { setCtxMenu(null); setCopied(false); }, []);

  // Long-press support for mobile
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  const [longPressTarget, setLongPressTarget] = useState<string | null>(null);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    setLongPressTarget(null);
  }, []);

  const ctxTask = ctxMenu ? tasks.find((t) => t.id === ctxMenu.taskId) : null;

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
          {sortedTasks.map((task) => {
            const isActive = task.id === activeTaskId;
            const indicator = taskIndicators.get(task.id);
            const initials = task.title.slice(0, 2).toUpperCase();

            return (
              <button
                key={task.id}
                onClick={() => onSelectTask(task.id)}
                title={task.title}
                className={`relative w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0 transition-colors cursor-pointer ${STATUS_BG[task.status]} ${isActive ? "ring-2 ring-accent" : ""} text-text-primary hover:brightness-110`}
              >
                {initials}
                {indicator === "busy" && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-info animate-pulse ring-2 ring-bg-secondary" />
                )}
                {indicator === "unread" && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success ring-2 ring-bg-secondary" />
                )}
              </button>
            );
          })}
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
        {sortedTasks.map((task) => {
          const isActive = task.id === activeTaskId;
          const indicator = taskIndicators.get(task.id);
          const linkCount =
            task.sessionIds.length +
            task.workItemIds.length +
            task.pullRequests.length;

          return (
            <button
              key={task.id}
              onClick={() => {
                if (longPressTriggered.current) {
                  longPressTriggered.current = false;
                  return;
                }
                onSelectTask(task.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, taskId: task.id });
                setCopied(false);
              }}
              onTouchStart={(e) => {
                const touch = e.touches[0];
                touchOrigin.current = { x: touch.clientX, y: touch.clientY };
                longPressTriggered.current = false;
                setLongPressTarget(task.id);
                longPressTimer.current = setTimeout(() => {
                  longPressTriggered.current = true;
                  setLongPressTarget(null);
                  setCtxMenu({ x: touch.clientX, y: touch.clientY, taskId: task.id });
                  setCopied(false);
                }, 500);
              }}
              onTouchMove={(e) => {
                if (!touchOrigin.current) return;
                const touch = e.touches[0];
                const dx = touch.clientX - touchOrigin.current.x;
                const dy = touch.clientY - touchOrigin.current.y;
                if (dx * dx + dy * dy > 100) cancelLongPress();
              }}
              onTouchEnd={() => cancelLongPress()}
              onTouchCancel={() => cancelLongPress()}
              className={`w-full text-left px-3 py-2 rounded-md text-sm select-none no-callout transition-all duration-150 ${
                ctxMenu?.taskId === task.id
                  ? "bg-bg-hover ring-1 ring-border"
                  : isActive
                    ? "bg-accent/10 border-l-2 border-accent"
                    : "hover:bg-bg-hover"
              } ${longPressTarget === task.id ? "scale-[0.97] bg-bg-hover" : ""}`}
            >
              <div className="flex items-center gap-2">
                {indicator && (
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      indicator === "busy"
                        ? "bg-info animate-pulse"
                        : "bg-success"
                    }`}
                  />
                )}
                <span className={`font-medium truncate flex-1 ${task.title === "New Task" ? "italic text-text-muted" : ""}`}>
                  {task.title}
                </span>
                <span className={`text-[10px] ${STATUS_TEXT[task.status]}`}>
                  {task.status !== "active" ? task.status : ""}
                </span>
              </div>
              <div className="text-xs text-text-muted mt-0.5 pl-3.5">
                {timeAgo(task.updatedAt)}
                {linkCount > 0 && ` · ${linkCount} linked`}
              </div>
            </button>
          );
        })}
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
                task.workItemIds.length +
                task.pullRequests.length;

              return (
                <button
                  key={task.id}
                  onClick={() => {
                    if (longPressTriggered.current) {
                      longPressTriggered.current = false;
                      return;
                    }
                    onSelectTask(task.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, taskId: task.id });
                    setCopied(false);
                  }}
                  onTouchStart={(e) => {
                    const touch = e.touches[0];
                    touchOrigin.current = { x: touch.clientX, y: touch.clientY };
                    longPressTriggered.current = false;
                    setLongPressTarget(task.id);
                    longPressTimer.current = setTimeout(() => {
                      longPressTriggered.current = true;
                      setLongPressTarget(null);
                      setCtxMenu({ x: touch.clientX, y: touch.clientY, taskId: task.id });
                      setCopied(false);
                    }, 500);
                  }}
                  onTouchMove={(e) => {
                    if (!touchOrigin.current) return;
                    const touch = e.touches[0];
                    const dx = touch.clientX - touchOrigin.current.x;
                    const dy = touch.clientY - touchOrigin.current.y;
                    if (dx * dx + dy * dy > 100) cancelLongPress();
                  }}
                  onTouchEnd={() => cancelLongPress()}
                  onTouchCancel={() => cancelLongPress()}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm select-none no-callout transition-all duration-150 opacity-60 ${
                    ctxMenu?.taskId === task.id
                      ? "bg-bg-hover ring-1 ring-border"
                      : isActive
                        ? "bg-accent/10 border-l-2 border-accent"
                        : "hover:bg-bg-hover"
                  } ${longPressTarget === task.id ? "scale-[0.97] bg-bg-hover" : ""}`}
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
          {onDeleteTask && (
            <>
              <CtxDivider />
              <CtxItem icon={<Trash2 size={14} />} label="Delete" className="text-error"
                onClick={() => { onDeleteTask(ctxTask.id); closeMenu(); }} />
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
