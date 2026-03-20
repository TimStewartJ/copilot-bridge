import type { Task, Session } from "../api";

interface DashboardProps {
  tasks: Task[];
  sessions: Session[];
  allSessions?: Session[];
  onSelectTask: (id: string) => void;
  onSelectSession: (id: string) => void;
  onNewTask: () => void;
  onNewSession: () => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
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
  tasks,
  sessions,
  allSessions,
  onSelectTask,
  onSelectSession,
  onNewTask,
  onNewSession,
  isUnread,
}: DashboardProps) {
  const lookupSessions = allSessions ?? sessions;
  const activeTasks = tasks.filter((t) => t.status === "active");
  const pausedTasks = tasks.filter((t) => t.status === "paused");
  const doneTasks = tasks.filter((t) => t.status === "done");
  const recentSessions = sessions.slice(0, 5);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <h1 className="text-xl md:text-2xl font-semibold mb-6">Dashboard</h1>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-8">
        <StatCard label="Active Tasks" value={activeTasks.length} color="green" />
        <StatCard label="Paused" value={pausedTasks.length} color="yellow" />
        <StatCard label="Completed" value={doneTasks.length} color="gray" />
        <StatCard label="Sessions" value={sessions.length} color="blue" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Active Tasks */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-text-muted">Active Tasks</h2>
            <button
              onClick={onNewTask}
              className="text-xs text-accent hover:text-accent-hover"
            >
              + New
            </button>
          </div>
          <div className="space-y-2">
            {activeTasks.length === 0 && (
              <div className="text-sm text-text-faint py-4 text-center">
                No active tasks
              </div>
            )}
            {activeTasks.map((task) => {
              let indicator: "busy" | "unread" | null = null;
              for (const sid of task.sessionIds) {
                const session = lookupSessions.find((s) => s.sessionId === sid);
                if (!session) continue;
                if (session.busy) { indicator = "busy"; break; }
                if (isUnread?.(sid, session.modifiedTime)) indicator = "unread";
              }
              return (
              <button
                key={task.id}
                onClick={() => onSelectTask(task.id)}
                className="w-full text-left px-4 py-3 bg-bg-surface hover:bg-bg-hover rounded-md transition-colors"
              >
                <div className="font-medium text-sm flex items-center gap-2">
                  {indicator && (
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        indicator === "busy"
                          ? "bg-info animate-pulse"
                          : "bg-success"
                      }`}
                    />
                  )}
                  {task.title}
                </div>
                <div className="text-xs text-text-muted mt-1">
                  {timeAgo(task.updatedAt)}
                  {task.workItemIds.length > 0 &&
                    ` · ${task.workItemIds.length} work items`}
                  {task.pullRequests.length > 0 &&
                    ` · ${task.pullRequests.length} PRs`}
                  {task.sessionIds.length > 0 &&
                    ` · ${task.sessionIds.length} sessions`}
                </div>
              </button>
              );
            })}
          </div>
        </div>

        {/* Recent Sessions */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-text-muted">
              Recent Sessions
            </h2>
            <button
              onClick={onNewSession}
              className="text-xs text-accent hover:text-accent-hover"
            >
              + New
            </button>
          </div>
          <div className="space-y-2">
            {recentSessions.map((s) => {
              const unread = isUnread?.(s.sessionId, s.modifiedTime);
              const dotColor = s.busy
                ? "bg-info animate-pulse"
                : unread
                  ? "bg-success"
                  : "bg-text-faint";
              return (
                <button
                  key={s.sessionId}
                  onClick={() => onSelectSession(s.sessionId)}
                  className="w-full text-left px-4 py-3 bg-bg-surface hover:bg-bg-hover rounded-md transition-colors"
                >
                  <div className="font-medium text-sm truncate flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
                    {s.summary || s.sessionId.slice(0, 8)}
                  </div>
                  <div className="text-xs text-text-muted mt-1 ml-4">
                    {timeAgo(s.modifiedTime)}
                    {s.context?.branch && ` · ${s.context.branch}`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    green: "text-success bg-success/10 border-success/20",
    yellow: "text-warning bg-warning/10 border-warning/20",
    gray: "text-text-muted bg-text-muted/10 border-text-muted/20",
    blue: "text-accent bg-accent/10 border-accent/20",
  };

  return (
    <div
      className={`px-4 py-3 rounded-md border ${colorMap[color] || colorMap.gray}`}
    >
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs opacity-70">{label}</div>
    </div>
  );
}
