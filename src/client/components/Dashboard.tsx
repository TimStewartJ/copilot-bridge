import { useState, useEffect } from "react";
import {
  fetchDashboard,
  type DashboardData,
  type DashboardActiveTask,
  type DashboardOrphanSession,
} from "../api";
import { Loader2, MessageSquare, Plus, Zap, GitPullRequest, LayoutList } from "lucide-react";

interface DashboardProps {
  onSelectTask: (id: string) => void;
  onSelectSession: (id: string) => void;
  onNewTask: () => void;
  onNewSession: () => void;
  onResumeTask: (taskId: string, sessionId?: string) => void;
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Dashboard({
  onSelectTask,
  onSelectSession,
  onNewTask,
  onNewSession,
  onResumeTask,
}: DashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDashboard = async () => {
    try {
      const d = await fetchDashboard();
      setData(d);
    } catch (err) {
      console.error("Failed to load dashboard:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
    // Auto-refresh every 15s when visible
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") loadDashboard();
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="animate-spin text-text-muted" size={24} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
        Failed to load dashboard
      </div>
    );
  }

  const { busySessions, unreadSessions, lastActiveTask, activeTasks, orphanSessions } = data;
  const hasAttention = busySessions.length > 0 || unreadSessions.length > 0;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* ── Attention Bar ─────────────────────────────────── */}
      {hasAttention && (
        <div className="border-b border-border bg-bg-secondary">
          <div className="max-w-5xl mx-auto px-4 md:px-8 py-3 space-y-2">
            {busySessions.length > 0 && (
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  <span className="flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-info opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-info" />
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-info">
                    {busySessions.length} agent{busySessions.length > 1 ? "s" : ""} working
                  </span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {busySessions.map((s) => (
                      <button
                        key={s.sessionId}
                        onClick={() => onSelectSession(s.sessionId)}
                        className="text-xs px-2 py-1 rounded bg-info/10 text-info hover:bg-info/20 transition-colors truncate max-w-[200px]"
                      >
                        {s.intentText || s.title}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {unreadSessions.length > 0 && (
              <div className="flex items-start gap-3">
                <div className="mt-1">
                  <span className="inline-flex rounded-full h-2 w-2 bg-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-success">
                    {unreadSessions.length} session{unreadSessions.length > 1 ? "s" : ""} with new results
                  </span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {unreadSessions.map((s) => (
                      <button
                        key={s.sessionId}
                        onClick={() => onSelectSession(s.sessionId)}
                        className="text-xs px-2 py-1 rounded bg-success/10 text-success hover:bg-success/20 transition-colors truncate max-w-[200px]"
                      >
                        {s.title}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 space-y-6">
        {/* ── Resume Strip ───────────────────────────────── */}
        {lastActiveTask && (
          <ResumeStrip
            activeTask={lastActiveTask}
            onResume={onResumeTask}
            onSelect={onSelectTask}
          />
        )}

        {/* ── Active Work (2-col) ────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Tasks in Flight (wider) */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
                <LayoutList size={14} />
                Tasks in Flight
              </h2>
              <button
                onClick={onNewTask}
                className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
              >
                <Plus size={12} />
                New Task
              </button>
            </div>

            {activeTasks.length === 0 ? (
              <EmptyState
                message="Nothing in flight"
                sub="Create a task to get started"
                action={onNewTask}
                actionLabel="New Task"
              />
            ) : (
              <div className="space-y-2">
                {activeTasks.map((at) => (
                  <TaskCard
                    key={at.task.id}
                    data={at}
                    isResume={at.task.id === lastActiveTask?.task.id}
                    onSelect={() => onSelectTask(at.task.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Right: Orphan Sessions */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
                <MessageSquare size={14} />
                Recent Chats
              </h2>
              <button
                onClick={onNewSession}
                className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
              >
                <Plus size={12} />
                Quick Chat
              </button>
            </div>

            {orphanSessions.length === 0 ? (
              <EmptyState
                message="All caught up"
                sub="No unlinked sessions need attention"
              />
            ) : (
              <div className="space-y-1.5">
                {orphanSessions.map((s) => (
                  <OrphanSessionRow
                    key={s.sessionId}
                    session={s}
                    onSelect={() => onSelectSession(s.sessionId)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function ResumeStrip({
  activeTask,
  onResume,
  onSelect,
}: {
  activeTask: DashboardActiveTask;
  onResume: (taskId: string, sessionId?: string) => void;
  onSelect: (taskId: string) => void;
}) {
  const t = activeTask.task;
  const lastSessionId = t.sessionIds.length > 0 ? t.sessionIds[t.sessionIds.length - 1] : undefined;

  return (
    <div className="bg-bg-surface border border-border rounded-lg p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-faint mb-1">Pick up where you left off</div>
        <button
          onClick={() => onSelect(t.id)}
          className="font-medium text-sm text-text-primary hover:text-accent transition-colors truncate block"
        >
          {t.title}
        </button>
        <div className="text-xs text-text-muted mt-1 flex items-center gap-3">
          {activeTask.workItemSummary.total > 0 && (
            <span>{activeTask.workItemSummary.total} work items</span>
          )}
          {activeTask.prSummary.total > 0 && (
            <span>{activeTask.prSummary.active} active PR{activeTask.prSummary.active !== 1 ? "s" : ""}</span>
          )}
          <span>{timeAgo(activeTask.lastActivity)}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {lastSessionId && (
          <button
            onClick={() => onResume(t.id, lastSessionId)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5"
          >
            <MessageSquare size={12} />
            Resume Chat
          </button>
        )}
        <button
          onClick={() => onResume(t.id)}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-bg-hover text-text-primary hover:bg-border transition-colors flex items-center gap-1.5"
        >
          <Plus size={12} />
          New Chat
        </button>
      </div>
    </div>
  );
}

function TaskCard({
  data,
  isResume,
  onSelect,
}: {
  data: DashboardActiveTask;
  isResume: boolean;
  onSelect: () => void;
}) {
  const { task, workItemSummary, prSummary, hasUnread, hasBusySession } = data;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-4 py-3 rounded-md transition-colors border ${
        isResume
          ? "bg-accent/5 border-accent/20 hover:bg-accent/10"
          : "bg-bg-surface border-transparent hover:bg-bg-hover"
      }`}
    >
      <div className="flex items-center gap-2">
        {(hasUnread || hasBusySession) && (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              hasBusySession ? "bg-info animate-pulse" : "bg-success"
            }`}
          />
        )}
        <span className={`${hasUnread ? "font-semibold" : "font-medium"} text-sm truncate`}>{task.title}</span>
        {task.status === "paused" && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning shrink-0">
            paused
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 mt-1.5 ml-3.5 text-xs text-text-muted flex-wrap">
        {/* Work item state pills */}
        {workItemSummary.total > 0 && (
          <span className="flex items-center gap-1">
            <Zap size={10} />
            {Object.entries(workItemSummary.byState).map(([state, count]) => (
              <span
                key={state}
                className={`px-1.5 py-0.5 rounded text-[10px] ${
                  stateColor(state)
                }`}
              >
                {count} {state}
              </span>
            ))}
          </span>
        )}
        {/* PR summary */}
        {prSummary.total > 0 && (
          <span className="flex items-center gap-1">
            <GitPullRequest size={10} />
            {prSummary.active > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-accent/15 text-accent">
                {prSummary.active} active
              </span>
            )}
            {prSummary.completed > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-success/15 text-success">
                {prSummary.completed} merged
              </span>
            )}
          </span>
        )}
        <span>{timeAgo(data.lastActivity)}</span>
      </div>
    </button>
  );
}

function OrphanSessionRow({
  session,
  onSelect,
}: {
  session: DashboardOrphanSession;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
    >
      <div className="flex items-center gap-2">
        {(session.busy || session.unread) && (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              session.busy ? "bg-info animate-pulse" : "bg-success"
            }`}
          />
        )}
        <span className={`text-sm truncate ${session.unread ? "font-semibold" : ""}`}>
          {session.title || "Untitled"}
        </span>
      </div>
      <div className="text-xs text-text-muted mt-0.5 ml-3.5">
        {timeAgo(session.modifiedTime)}
        {session.branch && (
          <span className="text-text-faint"> · {session.branch}</span>
        )}
      </div>
    </button>
  );
}

function EmptyState({
  message,
  sub,
  action,
  actionLabel,
}: {
  message: string;
  sub: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="text-center py-8 px-4 rounded-md bg-bg-surface border border-border">
      <div className="text-sm text-text-muted">{message}</div>
      <div className="text-xs text-text-faint mt-1">{sub}</div>
      {action && actionLabel && (
        <button
          onClick={action}
          className="mt-3 text-xs text-accent hover:text-accent-hover flex items-center gap-1 mx-auto"
        >
          <Plus size={12} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (s === "active" || s === "in progress" || s === "committed")
    return "bg-info/15 text-info";
  if (s === "new" || s === "to do" || s === "proposed")
    return "bg-text-muted/15 text-text-muted";
  if (s === "resolved" || s === "done" || s === "closed" || s === "completed")
    return "bg-success/15 text-success";
  if (s === "removed")
    return "bg-danger/15 text-danger";
  return "bg-text-muted/10 text-text-muted";
}
