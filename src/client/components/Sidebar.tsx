import type { Session, Task } from "../api";
import TaskList from "./TaskList";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type TabMode = "tasks" | "sessions";

interface SidebarProps {
  // Navigation
  activeTab: TabMode;
  onTabChange: (tab: TabMode) => void;
  onGoHome: () => void;
  // Tasks
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  // Sessions
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

export default function Sidebar({
  activeTab,
  onTabChange,
  onGoHome,
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: SidebarProps) {
  return (
    <div className="w-full h-full bg-[#16213e] border-r border-[#2a2a4a] flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-[#2a2a4a]">
        <button
          onClick={onGoHome}
          className="text-sm font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          🤖 Copilot Bridge
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#2a2a4a]">
        <button
          onClick={() => onTabChange("tasks")}
          className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${
            activeTab === "tasks"
              ? "text-indigo-400 border-b-2 border-indigo-400"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          📋 Tasks
        </button>
        <button
          onClick={() => onTabChange("sessions")}
          className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${
            activeTab === "sessions"
              ? "text-indigo-400 border-b-2 border-indigo-400"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          💬 Sessions
        </button>
      </div>

      {/* Content */}
      {activeTab === "tasks" ? (
        <TaskList
          tasks={tasks}
          activeTaskId={activeTaskId}
          onSelectTask={onSelectTask}
          onNewTask={onNewTask}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            onClick={onNewSession}
            className="w-full px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm rounded-md transition-colors"
          >
            + New Session
          </button>
          {sessions.map((s) => {
            const id = s.sessionId;
            const isActive = id === activeSessionId;
            return (
              <button
                key={id}
                onClick={() => onSelectSession(id)}
                className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-[#2a2a5e] border-l-3 border-indigo-400"
                    : "hover:bg-[#1a1a3e]"
                }`}
              >
                <div className="font-medium truncate">
                  {s.summary || id.slice(0, 8)}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {timeAgo(s.modifiedTime)}
                  {s.context?.branch && ` · ${s.context.branch}`}
                  {s.diskSizeBytes ? ` · ${formatSize(s.diskSizeBytes)}` : ""}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
