import { useMemo } from "react";
import type { Task, Session } from "../api";
import { Sparkles, MessageSquare, Plus, Settings, PanelLeftClose, PanelLeftOpen } from "lucide-react";

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
        if (!session) continue;
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
              onClick={() => onSelectTask(task.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                isActive
                  ? "bg-accent/10 border-l-2 border-accent"
                  : "hover:bg-bg-hover"
              }`}
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
    </div>
  );
}
