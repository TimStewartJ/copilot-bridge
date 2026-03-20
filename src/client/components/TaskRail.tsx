import { useMemo } from "react";
import type { Task, Session } from "../api";
import { Sparkles, MessageSquare, Plus, Settings } from "lucide-react";

interface TaskRailProps {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  onSelectQuickChats: () => void;
  isQuickChatsActive: boolean;
  onGoHome: () => void;
  onOpenSettings: () => void;
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

export default function TaskRail({
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
  onSelectQuickChats,
  isQuickChatsActive,
  onGoHome,
  onOpenSettings,
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

      {/* Quick Chats */}
      <div className="flex flex-col items-center gap-2 py-2">
        <button
          onClick={onSelectQuickChats}
          title="Quick Chats"
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${isQuickChatsActive ? "bg-bg-hover text-text-primary" : "text-text-muted hover:bg-bg-hover hover:text-text-primary"}`}
        >
          <MessageSquare size={18} />
        </button>

        {/* New task */}
        <button
          onClick={onNewTask}
          title="New Task"
          className="p-1.5 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Settings (pinned bottom) */}
      <div className="flex items-center justify-center py-3 mt-auto">
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
