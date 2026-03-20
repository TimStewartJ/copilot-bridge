import { useState, useEffect } from "react";
import type { Session, Task, EnrichedWorkItem, EnrichedPR } from "../api";
import { fetchEnrichedTask } from "../api";
import TaskList from "./TaskList";
import SessionList from "./SessionList";
import { Sparkles, Settings, ClipboardList, MessageSquare, Bug, CheckSquare, BookOpen, Target, Trophy, GitPullRequest, ChevronDown, ChevronRight } from "lucide-react";

type TabMode = "tasks" | "sessions";

interface SidebarProps {
  // Navigation
  activeTab: TabMode;
  onTabChange: (tab: TabMode) => void;
  onGoHome: () => void;
  onOpenSettings: () => void;
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
  onArchiveSession?: (id: string, archived: boolean) => void;
  // Task context (when navigating from task → session)
  taskContext: Task | null;
  taskContextSessions: Session[];
  onBackToTask: (taskId: string) => void;
  onSelectTaskSession: (sessionId: string) => void;
  onNewTaskSession: (taskId: string) => void;
  // Unread
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  unreadCount?: (sessions: Session[], activeSessionId?: string | null) => number;
}

export default function Sidebar({
  activeTab,
  onTabChange,
  onGoHome,
  onOpenSettings,
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onArchiveSession,
  taskContext,
  taskContextSessions,
  onBackToTask,
  onSelectTaskSession,
  onNewTaskSession,
  isUnread,
  unreadCount,
}: SidebarProps) {
  // If we have task context (navigated from task → session), show the task panel
  if (taskContext) {
    return (
      <div className="w-full h-full bg-bg-secondary border-r border-border flex flex-col">
        <TaskContextPanel
          task={taskContext}
          sessions={taskContextSessions}
          activeSessionId={activeSessionId}
          onBackToTask={onBackToTask}
          onSelectSession={onSelectTaskSession}
          onNewSession={onNewTaskSession}
          onGoHome={onGoHome}
          isUnread={isUnread}
        />
      </div>
    );
  }

  const sessionsUnread = unreadCount?.(sessions, activeSessionId) ?? 0;

  return (
    <div className="w-full h-full bg-bg-secondary border-r border-border flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <button
          onClick={onGoHome}
          className="text-sm font-medium text-text-primary hover:text-accent transition-colors flex items-center gap-1.5"
        >
          <Sparkles size={14} className="text-accent" />
          Copilot Bridge
        </button>
        <button
          onClick={onOpenSettings}
          className="text-text-muted hover:text-text-secondary transition-colors"
          title="Settings"
        >
          <Settings size={15} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => onTabChange("tasks")}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === "tasks"
              ? "text-accent border-b-2 border-accent"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <ClipboardList size={13} />
          Tasks
        </button>
        <button
          onClick={() => onTabChange("sessions")}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === "sessions"
              ? "text-accent border-b-2 border-accent"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <MessageSquare size={13} />
          Sessions
          {sessionsUnread > 0 && (
            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold bg-success/20 text-success rounded-full">
              {sessionsUnread}
            </span>
          )}
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
          onArchiveSession={onArchiveSession}
          isUnread={isUnread}
        />
      )}
    </div>
  );
}

// ── Task Context Panel ───────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  active: "bg-success/15 text-success",
  paused: "bg-warning/15 text-warning",
  done: "bg-text-muted/15 text-text-muted",
  archived: "bg-text-faint/15 text-text-faint",
};

interface TaskContextPanelProps {
  task: Task;
  sessions: Session[];
  activeSessionId: string | null;
  onBackToTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  onGoHome: () => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
}

function TaskContextPanel({
  task,
  sessions,
  activeSessionId,
  onBackToTask,
  onSelectSession,
  onNewSession,
  onGoHome,
  isUnread,
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
      <div className="p-4 border-b border-border">
        <button
          onClick={onGoHome}
          className="text-sm font-medium text-text-primary hover:text-accent transition-colors flex items-center gap-1.5"
        >
          <Sparkles size={14} className="text-accent" />
          Copilot Bridge
        </button>
      </div>

      {/* Back to task */}
      <div className="px-4 pt-3 pb-2 border-b border-border">
        <button
          onClick={() => onBackToTask(task.id)}
          className="text-xs text-text-muted hover:text-accent transition-colors flex items-center gap-1"
        >
          ← Back to Task
        </button>
        <div className="mt-2 flex items-start gap-2">
          <h2 className="text-sm font-medium text-text-primary leading-tight flex-1 min-w-0 line-clamp-2">
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
            isUnread={isUnread}
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
                  className="block px-3 py-1.5 text-xs text-accent hover:text-accent-hover hover:bg-bg-hover rounded-md transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span>{WI_TYPE_ICONS[wi.type ?? ""]?.icon ?? <ClipboardList size={12} />}</span>
                    <span className="font-medium">#{wi.id}</span>
                    {wi.title && (
                      <span className="text-text-muted truncate">{wi.title}</span>
                    )}
                  </div>
                  {wi.state && (
                    <div className="mt-0.5 ml-5">
                      <span className={`text-[9px] px-1 py-0.5 rounded-full ${WI_STATE_STYLES[wi.state] ?? "bg-text-muted/15 text-text-muted"}`}>
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
                  className="block px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    {pr.status && (
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PR_STATUS_DOTS[pr.status] ?? "bg-text-muted"}`} />
                    )}
                    {!pr.status && <GitPullRequest size={12} className="text-text-muted" />}
                    <span className="text-accent font-medium">#{pr.prId}</span>
                    {pr.title && (
                      <span className="text-text-muted truncate">{pr.title}</span>
                    )}
                  </div>
                  <div className="mt-0.5 ml-5 text-[10px] text-text-faint">
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
              <span className="text-[10px] text-text-faint">
                {notesExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              </span>
            </button>
            {notesExpanded && (
              <div className="px-3 py-2 bg-bg-surface rounded-md text-xs text-text-muted whitespace-pre-wrap max-h-40 overflow-y-auto">
                {task.notes}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const WI_TYPE_ICONS: Record<string, { icon: React.ReactNode }> = {
  Bug: { icon: <Bug size={12} className="text-error" /> },
  Task: { icon: <CheckSquare size={12} className="text-accent" /> },
  "User Story": { icon: <BookOpen size={12} className="text-success" /> },
  Feature: { icon: <Target size={12} className="text-purple-400" /> },
  Epic: { icon: <Trophy size={12} className="text-warning" /> },
};

const WI_STATE_STYLES: Record<string, string> = {
  New: "bg-text-muted/15 text-text-muted",
  Active: "bg-accent/15 text-accent",
  "In Progress": "bg-accent/15 text-accent",
  Resolved: "bg-success/15 text-success",
  Closed: "bg-text-faint/15 text-text-faint",
  Done: "bg-success/15 text-success",
};

const PR_STATUS_DOTS: Record<string, string> = {
  active: "bg-success",
  completed: "bg-accent",
  abandoned: "bg-text-muted",
};

function SectionLabel({ label, count }: { label: string; count?: number }) {
  return (
    <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-3 py-1">
      {label}
      {count !== undefined && (
        <span className="text-text-faint ml-1">({count})</span>
      )}
    </div>
  );
}
