import { useState, useEffect, useCallback } from "react";
import {
  fetchTask,
  fetchEnrichedTask,
  patchTask,
  deleteTask,
  linkResource,
  unlinkResource,
  createTaskSession,
  type Task,
  type Session,
  type EnrichedWorkItem,
  type EnrichedPR,
  type EnrichedTaskData,
} from "../api";
import NotesEditor from "./NotesEditor";
import LinkDialog from "./LinkDialog";

interface TaskDetailViewProps {
  taskId: string;
  sessions: Session[];
  onTaskUpdated: () => void;
  onTaskDeleted: () => void;
  onOpenSession: (sessionId: string) => void;
}

const STATUS_OPTIONS = ["active", "paused", "done", "archived"] as const;
const STATUS_STYLES = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  paused: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  done: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  archived: "bg-gray-700/20 text-gray-600 border-gray-700/30",
} as const;

// ── Helpers ───────────────────────────────────────────────────────

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const WI_TYPE_ICONS: Record<string, { icon: string; color: string }> = {
  Bug: { icon: "🐛", color: "text-red-400" },
  Task: { icon: "✅", color: "text-blue-400" },
  "User Story": { icon: "📖", color: "text-green-400" },
  Feature: { icon: "🎯", color: "text-purple-400" },
  Epic: { icon: "👑", color: "text-orange-400" },
};

const WI_STATE_STYLES: Record<string, string> = {
  New: "bg-gray-500/20 text-gray-400",
  Active: "bg-blue-500/20 text-blue-400",
  "In Progress": "bg-blue-500/20 text-blue-400",
  Resolved: "bg-green-500/20 text-green-400",
  Closed: "bg-gray-600/20 text-gray-500",
  Done: "bg-green-500/20 text-green-400",
  Removed: "bg-red-500/20 text-red-400",
};

const PR_STATUS_STYLES: Record<string, { dot: string; label: string; text: string }> = {
  active: { dot: "bg-green-400", label: "Active", text: "text-green-400" },
  completed: { dot: "bg-blue-400", label: "Completed", text: "text-blue-400" },
  abandoned: { dot: "bg-gray-500", label: "Abandoned", text: "text-gray-500" },
};

// ── Main Component ────────────────────────────────────────────────

export default function TaskDetailView({
  taskId,
  sessions,
  onTaskUpdated,
  onTaskDeleted,
  onOpenSession,
}: TaskDetailViewProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [enrichedWIs, setEnrichedWIs] = useState<EnrichedWorkItem[]>([]);
  const [enrichedPRs, setEnrichedPRs] = useState<EnrichedPR[]>([]);
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwdDraft, setCwdDraft] = useState("");

  const loadTask = useCallback(async () => {
    try {
      const t = await fetchTask(taskId);
      setTask(t);
      setTitleDraft(t.title);
      setCwdDraft(t.cwd || "");
    } catch (err) {
      console.error("Failed to load task:", err);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Load enriched data (async, non-blocking)
  const loadEnriched = useCallback(async () => {
    setEnrichmentLoading(true);
    try {
      const data = await fetchEnrichedTask(taskId);
      setEnrichedWIs(data.workItems);
      setEnrichedPRs(data.pullRequests);
    } catch (err) {
      console.error("Failed to load enriched data:", err);
    } finally {
      setEnrichmentLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    setEnrichedWIs([]);
    setEnrichedPRs([]);
    loadTask();
    loadEnriched();
  }, [loadTask, loadEnriched]);

  if (loading || !task) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Loading task...
      </div>
    );
  }

  const handleStatusChange = async (status: Task["status"]) => {
    const updated = await patchTask(task.id, { status });
    setTask(updated);
    onTaskUpdated();
  };

  const handleTitleSave = async () => {
    if (titleDraft.trim() && titleDraft !== task.title) {
      const updated = await patchTask(task.id, { title: titleDraft.trim() });
      setTask(updated);
      onTaskUpdated();
    }
    setEditingTitle(false);
  };

  const handleCwdSave = async () => {
    const newCwd = cwdDraft.trim();
    if (newCwd !== (task.cwd || "")) {
      const updated = await patchTask(task.id, { cwd: newCwd });
      setTask(updated);
      onTaskUpdated();
    }
    setEditingCwd(false);
  };

  const handleNotesSave = async (notes: string) => {
    const updated = await patchTask(task.id, { notes });
    setTask(updated);
  };

  const handleLink = async (resource: any) => {
    const updated = await linkResource(task.id, resource);
    setTask(updated);
    onTaskUpdated();
    setLinkDialogOpen(false);
    loadEnriched(); // refresh enrichment
  };

  const handleUnlink = async (resource: any) => {
    const updated = await unlinkResource(task.id, resource);
    setTask(updated);
    onTaskUpdated();
    // Remove from enriched state immediately
    if (resource.type === "workItem") {
      setEnrichedWIs((prev) => prev.filter((w) => w.id !== resource.workItemId));
    } else if (resource.type === "pr") {
      setEnrichedPRs((prev) => prev.filter((p) => !(p.repoId === resource.repoId && p.prId === resource.prId)));
    }
  };

  const linkedSessions = sessions.filter((s) =>
    task.sessionIds.includes(s.sessionId),
  );

  // Compute state summaries
  const wiStateCounts = enrichedWIs.reduce<Record<string, number>>((acc, wi) => {
    if (wi.state) acc[wi.state] = (acc[wi.state] || 0) + 1;
    return acc;
  }, {});

  const prStatusCounts = enrichedPRs.reduce<Record<string, number>>((acc, pr) => {
    if (pr.status) acc[pr.status] = (acc[pr.status] || 0) + 1;
    return acc;
  }, {});

  const busySessionCount = linkedSessions.filter((s) => s.busy).length;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="p-4 md:p-6 border-b border-[#2a2a4a]">
        <div className="flex flex-wrap items-start gap-3 md:gap-4">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => e.key === "Enter" && handleTitleSave()}
                autoFocus
                className="text-xl md:text-2xl font-bold bg-transparent border-b border-indigo-400 outline-none w-full text-gray-100"
              />
            ) : (
              <h1
                onClick={() => setEditingTitle(true)}
                className="text-xl md:text-2xl font-bold cursor-pointer hover:text-indigo-400 transition-colors"
              >
                {task.title}
              </h1>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => handleStatusChange(s)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                    task.status === s
                      ? STATUS_STYLES[s]
                      : "border-gray-600 text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLinkDialogOpen(true)}
              className="px-3 md:px-4 py-2 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-md text-sm hover:bg-indigo-500/30 transition-colors"
            >
              + Link
            </button>
            {task.status !== "archived" && (
              <button
                onClick={() => handleStatusChange("archived")}
                className="px-3 md:px-4 py-2 text-gray-500 hover:text-yellow-400 text-sm transition-colors"
                title="Archive task"
              >
                📦
              </button>
            )}
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="px-3 md:px-4 py-2 text-gray-500 hover:text-red-400 text-sm transition-colors"
                title="Delete task"
              >
                🗑️
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  onClick={async () => {
                    await deleteTask(task.id);
                    onTaskDeleted();
                  }}
                  className="px-3 py-2 bg-red-500/20 text-red-400 border border-red-500/30 rounded-md text-xs hover:bg-red-500/30 transition-colors"
                >
                  Confirm Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-2 text-gray-500 hover:text-gray-300 text-xs transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-6">
        {/* Working Directory */}
        <Section title="📂 Working Directory">
          {editingCwd ? (
            <input
              value={cwdDraft}
              onChange={(e) => setCwdDraft(e.target.value)}
              onBlur={handleCwdSave}
              onKeyDown={(e) => e.key === "Enter" && handleCwdSave()}
              autoFocus
              placeholder="e.g. D:\my-project"
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-indigo-400/50 rounded-md text-sm text-gray-200 outline-none font-mono"
            />
          ) : (
            <button
              onClick={() => setEditingCwd(true)}
              className="w-full text-left px-3 py-2 bg-[#2a2a4a] rounded-md text-sm hover:bg-[#32325a] transition-colors font-mono"
            >
              {task.cwd ? (
                <span className="text-gray-200">{task.cwd}</span>
              ) : (
                <span className="text-gray-500 italic">No working directory set</span>
              )}
            </button>
          )}
        </Section>

        {/* Work Items */}
        <Section
          title="📋 Work Items"
          count={task.workItemIds.length}
          summary={
            Object.keys(wiStateCounts).length > 0
              ? Object.entries(wiStateCounts)
                  .map(([state, count]) => `${count} ${state}`)
                  .join(" · ")
              : undefined
          }
        >
          {task.workItemIds.length === 0 ? (
            <Empty>No work items linked</Empty>
          ) : enrichmentLoading && enrichedWIs.length === 0 ? (
            <div className="space-y-1">
              {task.workItemIds.map((id) => (
                <SkeletonRow key={id} label={`#${id}`} />
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              {(enrichedWIs.length > 0 ? enrichedWIs : task.workItemIds.map(bareWorkItem)).map((wi) => (
                <WorkItemRow
                  key={wi.id}
                  item={wi}
                  onUnlink={() => handleUnlink({ type: "workItem", workItemId: wi.id })}
                />
              ))}
            </div>
          )}
        </Section>

        {/* Pull Requests */}
        <Section
          title="🔀 Pull Requests"
          count={task.pullRequests.length}
          summary={
            Object.keys(prStatusCounts).length > 0
              ? Object.entries(prStatusCounts)
                  .map(([status, count]) => `${count} ${status.charAt(0).toUpperCase() + status.slice(1)}`)
                  .join(" · ")
              : undefined
          }
        >
          {task.pullRequests.length === 0 ? (
            <Empty>No PRs linked</Empty>
          ) : enrichmentLoading && enrichedPRs.length === 0 ? (
            <div className="space-y-1">
              {task.pullRequests.map((pr) => (
                <SkeletonRow key={`${pr.repoId}-${pr.prId}`} label={`PR #${pr.prId}`} />
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              {(enrichedPRs.length > 0 ? enrichedPRs : task.pullRequests.map(barePR)).map((pr) => (
                <PRRow
                  key={`${pr.repoId}-${pr.prId}`}
                  item={pr}
                  onUnlink={() => handleUnlink({ type: "pr", repoId: pr.repoId, prId: pr.prId })}
                />
              ))}
            </div>
          )}
        </Section>

        {/* Sessions */}
        <Section
          title="💬 Sessions"
          count={task.sessionIds.length}
          summary={busySessionCount > 0 ? `${busySessionCount} busy` : undefined}
        >
          <button
            onClick={async () => {
              const sessionId = await createTaskSession(task.id);
              const updated = await fetchTask(task.id);
              setTask(updated);
              onTaskUpdated();
              onOpenSession(sessionId);
            }}
            className="w-full mb-2 px-3 py-2 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-md text-sm hover:bg-indigo-500/30 transition-colors"
          >
            + New Chat for this Task
          </button>
          {linkedSessions.length === 0 ? (
            <Empty>No sessions linked</Empty>
          ) : (
            <div className="space-y-1">
              {linkedSessions.map((s) => (
                <SessionRow
                  key={s.sessionId}
                  session={s}
                  onOpen={() => onOpenSession(s.sessionId)}
                  onUnlink={() => handleUnlink({ type: "session", sessionId: s.sessionId })}
                />
              ))}
            </div>
          )}
        </Section>

        {/* Notes */}
        <Section title="📝 Notes">
          <NotesEditor value={task.notes} onSave={handleNotesSave} />
        </Section>
      </div>

      {/* Link Dialog */}
      {linkDialogOpen && (
        <LinkDialog
          sessions={sessions}
          onLink={handleLink}
          onClose={() => setLinkDialogOpen(false)}
        />
      )}
    </div>
  );
}

// ── Bare fallbacks when enrichment isn't available ────────────────

function bareWorkItem(id: number): EnrichedWorkItem {
  return {
    id,
    title: null,
    state: null,
    type: null,
    assignedTo: null,
    areaPath: null,
    url: `https://my-org.visualstudio.com/MyProject/_workitems/edit/${id}`,
  };
}

function barePR(pr: { repoId: string; repoName?: string; prId: number }): EnrichedPR {
  return {
    repoId: pr.repoId,
    repoName: pr.repoName ?? null,
    prId: pr.prId,
    title: null,
    status: null,
    createdBy: null,
    reviewerCount: 0,
    url: `https://my-org.visualstudio.com/MyProject/_git/${pr.repoName ?? pr.repoId}/pullrequest/${pr.prId}`,
  };
}

// ── Work Item Row ─────────────────────────────────────────────────

function WorkItemRow({ item, onUnlink }: { item: EnrichedWorkItem; onUnlink: () => void }) {
  const typeInfo = WI_TYPE_ICONS[item.type ?? ""] ?? { icon: "📋", color: "text-gray-400" };
  const stateStyle = WI_STATE_STYLES[item.state ?? ""] ?? "bg-gray-500/20 text-gray-400";

  return (
    <div className="group flex items-start gap-2.5 px-3 py-2 bg-[#2a2a4a] rounded-md hover:bg-[#32325a] transition-colors">
      <span className={`text-sm mt-0.5 ${typeInfo.color}`}>{typeInfo.icon}</span>
      <a
        href={item.url}
        target="_blank"
        rel="noopener"
        className="flex-1 min-w-0"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-indigo-400 hover:underline font-medium">
            #{item.id}
          </span>
          {item.title && (
            <span className="text-sm text-gray-300 truncate">
              {item.title}
            </span>
          )}
        </div>
        {(item.state || item.assignedTo) && (
          <div className="flex items-center gap-2 mt-0.5">
            {item.state && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${stateStyle}`}>
                {item.state}
              </span>
            )}
            {item.assignedTo && (
              <span className="text-[11px] text-gray-500 truncate">
                {item.assignedTo}
              </span>
            )}
          </div>
        )}
      </a>
      <button
        onClick={(e) => { e.preventDefault(); onUnlink(); }}
        className="text-xs text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
        title="Unlink"
      >
        ✕
      </button>
    </div>
  );
}

// ── PR Row ────────────────────────────────────────────────────────

function PRRow({ item, onUnlink }: { item: EnrichedPR; onUnlink: () => void }) {
  const statusInfo = PR_STATUS_STYLES[item.status ?? ""] ?? PR_STATUS_STYLES.active;

  return (
    <div className="group flex items-start gap-2.5 px-3 py-2 bg-[#2a2a4a] rounded-md hover:bg-[#32325a] transition-colors">
      <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${statusInfo.dot}`} />
      <a
        href={item.url}
        target="_blank"
        rel="noopener"
        className="flex-1 min-w-0"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-indigo-400 hover:underline font-medium">
            PR #{item.prId}
          </span>
          {item.title && (
            <span className="text-sm text-gray-300 truncate">
              {item.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-gray-500">
            {item.repoName || item.repoId}
          </span>
          {item.status && (
            <span className={`text-[10px] ${statusInfo.text}`}>
              {statusInfo.label}
            </span>
          )}
          {item.reviewerCount > 0 && (
            <span className="text-[10px] text-gray-500">
              {item.reviewerCount} reviewer{item.reviewerCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </a>
      <button
        onClick={(e) => { e.preventDefault(); onUnlink(); }}
        className="text-xs text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
        title="Unlink"
      >
        ✕
      </button>
    </div>
  );
}

// ── Session Row ───────────────────────────────────────────────────

function SessionRow({
  session,
  onOpen,
  onUnlink,
}: {
  session: Session;
  onOpen: () => void;
  onUnlink: () => void;
}) {
  return (
    <div className="group flex items-start gap-2.5 px-3 py-2 bg-[#2a2a4a] rounded-md hover:bg-[#32325a] transition-colors">
      <div className="mt-1 shrink-0">
        {session.busy ? (
          <span className="inline-block w-2 h-2 bg-green-400 rounded-full animate-pulse" />
        ) : (
          <span className="inline-block w-2 h-2 bg-gray-600 rounded-full" />
        )}
      </div>
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 text-left"
      >
        <div className="text-sm text-indigo-400 hover:underline font-medium truncate">
          {session.summary || session.sessionId.slice(0, 8)}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-gray-500">
          {timeAgo(session.modifiedTime) && (
            <span>{timeAgo(session.modifiedTime)}</span>
          )}
          {session.context?.branch && (
            <>
              <span>·</span>
              <span className="font-mono truncate max-w-[140px]">{session.context.branch}</span>
            </>
          )}
          {session.hasPlan && (
            <>
              <span>·</span>
              <span>📋</span>
            </>
          )}
          {session.diskSizeBytes ? (
            <>
              <span>·</span>
              <span>{formatSize(session.diskSizeBytes)}</span>
            </>
          ) : null}
        </div>
      </button>
      <button
        onClick={onUnlink}
        className="text-xs text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
        title="Unlink"
      >
        ✕
      </button>
    </div>
  );
}

// ── Skeleton loading row ──────────────────────────────────────────

function SkeletonRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 bg-[#2a2a4a] rounded-md">
      <span className="text-sm text-gray-500">{label}</span>
      <div className="flex-1 flex items-center gap-2">
        <div className="h-3 w-32 bg-gray-700 rounded animate-pulse" />
        <div className="h-3 w-16 bg-gray-700 rounded animate-pulse" />
      </div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────

function Section({
  title,
  count,
  summary,
  children,
}: {
  title: string;
  count?: number;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-400 mb-2 flex items-center gap-2">
        <span>
          {title}
          {count !== undefined && (
            <span className="text-gray-600 ml-1">({count})</span>
          )}
        </span>
        {summary && (
          <span className="text-[10px] text-gray-500 font-normal">
            {summary}
          </span>
        )}
      </h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-gray-600 px-3 py-2">{children}</div>;
}
