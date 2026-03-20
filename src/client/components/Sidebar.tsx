import { useState, useEffect } from "react";
import type { Session, Task, EnrichedWorkItem, EnrichedPR } from "../api";
import { fetchEnrichedTask } from "../api";
import TaskList from "./TaskList";
import SessionList from "./SessionList";

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
        <SessionList
          variant="global"
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={onSelectSession}
          onNewSession={onNewSession}
        />
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
  const [enrichedWIs, setEnrichedWIs] = useState<EnrichedWorkItem[]>([]);
  const [enrichedPRs, setEnrichedPRs] = useState<EnrichedPR[]>([]);

  const linkedSessions = sessions.filter((s) =>
    task.sessionIds.includes(s.sessionId),
  );

  useEffect(() => {
    if (task.workItemIds.length > 0 || task.pullRequests.length > 0) {
      fetchEnrichedTask(task.id)
        .then((data) => {
          setEnrichedWIs(data.workItems);
          setEnrichedPRs(data.pullRequests);
        })
        .catch(() => {});
    }
  }, [task.id, task.workItemIds.length, task.pullRequests.length]);

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
          <SessionList
            variant="compact"
            sessions={linkedSessions}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onNewSession={() => onNewSession(task.id)}
          />
        </div>

        {/* Work Items */}
        {task.workItemIds.length > 0 && (
          <div>
            <SectionLabel label="Work Items" count={task.workItemIds.length} />
            <div className="space-y-0.5">
              {(enrichedWIs.length > 0 ? enrichedWIs : task.workItemIds.map((id) => ({ id, title: null, state: null, type: null, assignedTo: null, areaPath: null, url: `https://my-org.visualstudio.com/MyProject/_workitems/edit/${id}` }))).map((wi) => (
                <a
                  key={wi.id}
                  href={wi.url}
                  target="_blank"
                  rel="noopener"
                  className="block px-3 py-1.5 text-xs text-indigo-400 hover:text-indigo-300 hover:bg-[#1a1a3e] rounded-md transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span>{WI_TYPE_ICONS[wi.type ?? ""]?.icon ?? "📋"}</span>
                    <span className="font-medium">#{wi.id}</span>
                    {wi.title && (
                      <span className="text-gray-400 truncate">{wi.title}</span>
                    )}
                  </div>
                  {wi.state && (
                    <div className="mt-0.5 ml-5">
                      <span className={`text-[9px] px-1 py-0.5 rounded-full ${WI_STATE_STYLES[wi.state] ?? "bg-gray-500/20 text-gray-400"}`}>
                        {wi.state}
                      </span>
                    </div>
                  )}
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
              {(enrichedPRs.length > 0 ? enrichedPRs : task.pullRequests.map((pr) => ({ repoId: pr.repoId, repoName: pr.repoName ?? null, prId: pr.prId, title: null, status: null as any, createdBy: null, reviewerCount: 0, url: `https://my-org.visualstudio.com/MyProject/_git/${pr.repoName ?? pr.repoId}/pullrequest/${pr.prId}` }))).map((pr) => (
                <a
                  key={`${pr.repoId}-${pr.prId}`}
                  href={pr.url}
                  target="_blank"
                  rel="noopener"
                  className="block px-3 py-1.5 text-xs text-gray-300 hover:bg-[#1a1a3e] rounded-md transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    {pr.status && (
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PR_STATUS_DOTS[pr.status] ?? "bg-gray-500"}`} />
                    )}
                    {!pr.status && <span>🔀</span>}
                    <span className="text-indigo-400 font-medium">#{pr.prId}</span>
                    {pr.title && (
                      <span className="text-gray-400 truncate">{pr.title}</span>
                    )}
                  </div>
                  <div className="mt-0.5 ml-5 text-[10px] text-gray-500">
                    {pr.repoName || pr.repoId}
                    {pr.status && ` · ${pr.status.charAt(0).toUpperCase() + pr.status.slice(1)}`}
                  </div>
                </a>
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

const WI_TYPE_ICONS: Record<string, { icon: string }> = {
  Bug: { icon: "🐛" },
  Task: { icon: "✅" },
  "User Story": { icon: "📖" },
  Feature: { icon: "🎯" },
  Epic: { icon: "👑" },
};

const WI_STATE_STYLES: Record<string, string> = {
  New: "bg-gray-500/20 text-gray-400",
  Active: "bg-blue-500/20 text-blue-400",
  "In Progress": "bg-blue-500/20 text-blue-400",
  Resolved: "bg-green-500/20 text-green-400",
  Closed: "bg-gray-600/20 text-gray-500",
  Done: "bg-green-500/20 text-green-400",
};

const PR_STATUS_DOTS: Record<string, string> = {
  active: "bg-green-400",
  completed: "bg-blue-400",
  abandoned: "bg-gray-500",
};

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
