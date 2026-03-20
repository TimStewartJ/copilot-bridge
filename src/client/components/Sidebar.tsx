import { useState } from "react";
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
  // Task context (when navigating from task → session)
  taskContext: Task | null;
  taskContextSessions: Session[];
  onBackToTask: (taskId: string) => void;
  onSelectTaskSession: (sessionId: string) => void;
  onNewTaskSession: (taskId: string) => void;
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
  taskContext,
  taskContextSessions,
  onBackToTask,
  onSelectTaskSession,
  onNewTaskSession,
}: SidebarProps) {
  // If we have task context (navigated from task → session), show the task panel
  if (taskContext) {
    return (
      <div className="w-full h-full bg-[#16213e] border-r border-[#2a2a4a] flex flex-col">
        <TaskContextPanel
          task={taskContext}
          sessions={taskContextSessions}
          activeSessionId={activeSessionId}
          onBackToTask={onBackToTask}
          onSelectSession={onSelectTaskSession}
          onNewSession={onNewTaskSession}
          onGoHome={onGoHome}
        />
      </div>
    );
  }

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
                onContextMenu={(e) => {
                  e.preventDefault();
                  navigator.clipboard.writeText(id);
                }}
                title={id}
                className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-[#2a2a5e] border-l-3 border-indigo-400"
                    : "hover:bg-[#1a1a3e]"
                }`}
              >
                <div className="font-medium truncate">
                  {s.busy && <span className="inline-block w-2 h-2 bg-green-400 rounded-full animate-pulse mr-1.5 align-middle" />}
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

// ── Task Context Panel ───────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/20 text-green-400",
  paused: "bg-yellow-500/20 text-yellow-400",
  done: "bg-gray-500/20 text-gray-400",
  archived: "bg-gray-700/20 text-gray-600",
};

interface TaskContextPanelProps {
  task: Task;
  sessions: Session[];
  activeSessionId: string | null;
  onBackToTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  onGoHome: () => void;
}

function TaskContextPanel({
  task,
  sessions,
  activeSessionId,
  onBackToTask,
  onSelectSession,
  onNewSession,
  onGoHome,
}: TaskContextPanelProps) {
  const [notesExpanded, setNotesExpanded] = useState(false);
  const linkedSessions = sessions.filter((s) =>
    task.sessionIds.includes(s.sessionId),
  );

  return (
    <>
      {/* Header */}
      <div className="p-4 border-b border-[#2a2a4a]">
        <button
          onClick={onGoHome}
          className="text-sm font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          🤖 Copilot Bridge
        </button>
      </div>

      {/* Back to task */}
      <div className="px-4 pt-3 pb-2 border-b border-[#2a2a4a]">
        <button
          onClick={() => onBackToTask(task.id)}
          className="text-xs text-gray-400 hover:text-indigo-400 transition-colors flex items-center gap-1"
        >
          ← Back to Task
        </button>
        <div className="mt-2 flex items-start gap-2">
          <h2 className="text-sm font-semibold text-gray-200 leading-tight flex-1 min-w-0 line-clamp-2">
            {task.title}
          </h2>
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[task.status] ?? ""}`}
          >
            {task.status}
          </span>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {/* Sessions */}
        <div>
          <SectionLabel label="Sessions" count={linkedSessions.length} />
          <button
            onClick={() => onNewSession(task.id)}
            className="w-full mb-1.5 px-3 py-1.5 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-md text-xs hover:bg-indigo-500/30 transition-colors"
          >
            + New Chat
          </button>
          {linkedSessions.length === 0 ? (
            <div className="text-xs text-gray-600 px-3 py-1">
              No sessions yet
            </div>
          ) : (
            <div className="space-y-0.5">
              {linkedSessions.map((s) => {
                const isActive = s.sessionId === activeSessionId;
                return (
                  <button
                    key={s.sessionId}
                    onClick={() => onSelectSession(s.sessionId)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      navigator.clipboard.writeText(s.sessionId);
                    }}
                    title={s.sessionId}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? "bg-[#2a2a5e] border-l-3 border-indigo-400"
                        : "hover:bg-[#1a1a3e]"
                    }`}
                  >
                    <div className="font-medium truncate text-xs">
                      {s.busy && <span className="inline-block w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse mr-1 align-middle" />}
                      {s.summary || s.sessionId.slice(0, 8)}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
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

        {/* Work Items */}
        {task.workItemIds.length > 0 && (
          <div>
            <SectionLabel label="Work Items" count={task.workItemIds.length} />
            <div className="space-y-0.5">
              {task.workItemIds.map((id) => (
                <a
                  key={id}
                  href={`https://my-org.visualstudio.com/MyProject/_workitems/edit/${id}`}
                  target="_blank"
                  rel="noopener"
                  className="block px-3 py-1.5 text-xs text-indigo-400 hover:text-indigo-300 hover:bg-[#1a1a3e] rounded-md transition-colors"
                >
                  📋 #{id}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Pull Requests */}
        {task.pullRequests.length > 0 && (
          <div>
            <SectionLabel label="Pull Requests" count={task.pullRequests.length} />
            <div className="space-y-0.5">
              {task.pullRequests.map((pr) => (
                <div
                  key={`${pr.repoId}-${pr.prId}`}
                  className="px-3 py-1.5 text-xs text-gray-300 rounded-md"
                >
                  🔀 {pr.repoName || pr.repoId.slice(0, 8)} #{pr.prId}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        {task.notes && (
          <div>
            <button
              onClick={() => setNotesExpanded((prev) => !prev)}
              className="w-full flex items-center gap-1 mb-1"
            >
              <SectionLabel label="Notes" />
              <span className="text-[10px] text-gray-600">
                {notesExpanded ? "▾" : "▸"}
              </span>
            </button>
            {notesExpanded && (
              <div className="px-3 py-2 bg-[#2a2a4a] rounded-md text-xs text-gray-400 whitespace-pre-wrap max-h-40 overflow-y-auto">
                {task.notes}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function SectionLabel({ label, count }: { label: string; count?: number }) {
  return (
    <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-3 py-1">
      {label}
      {count !== undefined && (
        <span className="text-gray-600 ml-1">({count})</span>
      )}
    </div>
  );
}
