import { useState } from "react";
import type { Task } from "../api";

const STATUS_ORDER = { active: 0, paused: 1, done: 2, archived: 3 } as const;
const STATUS_COLORS = {
  active: "bg-green-500/20 text-green-400",
  paused: "bg-yellow-500/20 text-yellow-400",
  done: "bg-gray-500/20 text-gray-400",
  archived: "bg-gray-700/20 text-gray-600",
} as const;

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
}

export default function TaskList({
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
}: TaskListProps) {
  const sorted = [...tasks].sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const grouped = {
    active: sorted.filter((t) => t.status === "active"),
    paused: sorted.filter((t) => t.status === "paused"),
    done: sorted.filter((t) => t.status === "done"),
    archived: sorted.filter((t) => t.status === "archived"),
  };

  const [showArchived, setShowArchived] = useState(false);

  const renderGroup = (label: string, items: Task[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label}>
        <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
          {label} ({items.length})
        </div>
        {items.map((task) => {
          const isActive = task.id === activeTaskId;
          const linkCount =
            task.sessionIds.length +
            task.workItemIds.length +
            task.pullRequests.length;
          return (
            <button
              key={task.id}
              onClick={() => onSelectTask(task.id)}
              className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${
                isActive
                  ? "bg-[#2a2a5e] border-l-3 border-indigo-400"
                  : "hover:bg-[#1a1a3e]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium truncate flex-1">
                  {task.title}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${STATUS_COLORS[task.status]}`}
                >
                  {task.status}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {timeAgo(task.updatedAt)}
                {linkCount > 0 && ` · ${linkCount} linked`}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-2">
      <button
        onClick={onNewTask}
        className="w-full px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm rounded-md transition-colors"
      >
        + New Task
      </button>
      {renderGroup("Active", grouped.active)}
      {renderGroup("Paused", grouped.paused)}
      {renderGroup("Done", grouped.done)}
      {grouped.archived.length > 0 && (
        <>
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="w-full px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {showArchived ? "▾" : "▸"} Archived ({grouped.archived.length})
          </button>
          {showArchived && renderGroup("Archived", grouped.archived)}
        </>
      )}
      {tasks.length === 0 && (
        <div className="text-center text-gray-500 text-sm py-8">
          No tasks yet
        </div>
      )}
    </div>
  );
}
