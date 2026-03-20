import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
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
import { Bug, CheckSquare, BookOpen, Target, Trophy, ClipboardList, GitPullRequest, MessageSquare, FileText, FolderOpen, Archive, ArchiveRestore, Trash2, Pencil, X } from "lucide-react";

interface TaskDetailViewProps {
  sessions: Session[];
  onTaskUpdated: () => void;
  onTaskDeleted: () => void;
  onOpenSession: (sessionId: string) => void;
  onSessionCreated?: (sessionId: string) => void;
  onArchiveSession?: (id: string, archived: boolean) => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
}

const STATUS_OPTIONS = ["active", "paused", "done", "archived"] as const;
const STATUS_STYLES = {
  active: "bg-success/15 text-success border-success/20",
  paused: "bg-warning/15 text-warning border-warning/20",
  done: "bg-text-muted/15 text-text-muted border-text-muted/20",
  archived: "bg-text-faint/15 text-text-faint border-text-faint/20",
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

const WI_TYPE_ICONS: Record<string, { icon: React.ReactNode; color: string }> = {
  Bug: { icon: <Bug size={14} />, color: "text-error" },
  Task: { icon: <CheckSquare size={14} />, color: "text-accent" },
  "User Story": { icon: <BookOpen size={14} />, color: "text-success" },
  Feature: { icon: <Target size={14} />, color: "text-purple-400" },
  Epic: { icon: <Trophy size={14} />, color: "text-warning" },
};

const WI_STATE_STYLES: Record<string, string> = {
  New: "bg-text-muted/15 text-text-muted",
  Active: "bg-accent/15 text-accent",
  "In Progress": "bg-accent/15 text-accent",
  Resolved: "bg-success/15 text-success",
  Closed: "bg-text-faint/15 text-text-faint",
  Done: "bg-success/15 text-success",
  Removed: "bg-error/15 text-error",
};

const PR_STATUS_STYLES: Record<string, { dot: string; label: string; text: string }> = {
  active: { dot: "bg-success", label: "Active", text: "text-success" },
  completed: { dot: "bg-accent", label: "Completed", text: "text-accent" },
  abandoned: { dot: "bg-text-muted", label: "Abandoned", text: "text-text-muted" },
};

// ── Main Component ────────────────────────────────────────────────

export default function TaskDetailView({
  sessions,
  onTaskUpdated,
  onTaskDeleted,
  onOpenSession,
  onSessionCreated,
  onArchiveSession,
  isUnread,
}: TaskDetailViewProps) {
  const { taskId } = useParams<{ taskId: string }>();
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
    if (!taskId) return;
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
    if (!taskId) return;
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
      <div className="flex-1 flex items-center justify-center text-text-muted">
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
  const unreadSessionCount = linkedSessions.filter(
    (s) => !s.busy && isUnread?.(s.sessionId, s.modifiedTime),
  ).length;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="p-4 md:p-6 border-b border-border">
        <div className="flex flex-wrap items-start gap-3 md:gap-4">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => e.key === "Enter" && handleTitleSave()}
                autoFocus
                className="text-xl md:text-2xl font-semibold bg-transparent border-b border-accent outline-none w-full text-text-primary"
              />
            ) : (
              <h1
                onClick={() => setEditingTitle(true)}
                className="text-xl md:text-2xl font-semibold cursor-pointer hover:text-accent transition-colors"
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
                      : "border-border text-text-muted hover:text-text-secondary"
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
              className="px-3 md:px-4 py-2 bg-accent/10 text-accent border border-accent/20 rounded-md text-sm hover:bg-accent/20 transition-colors"
            >
              + Link
            </button>
            {task.status !== "archived" && (
              <button
                onClick={() => handleStatusChange("archived")}
                className="px-3 md:px-4 py-2 text-text-muted hover:text-warning text-sm transition-colors"
                title="Archive task"
              >
                <Archive size={16} />
              </button>
            )}
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="px-3 md:px-4 py-2 text-text-muted hover:text-error text-sm transition-colors"
                title="Delete task"
              >
                <Trash2 size={16} />
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  onClick={async () => {
                    await deleteTask(task.id);
                    onTaskDeleted();
                  }}
                  className="px-3 py-2 bg-error/15 text-error border border-error/20 rounded-md text-xs hover:bg-error/20 transition-colors"
                >
                  Confirm Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-2 text-text-muted hover:text-text-secondary text-xs transition-colors"
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
        <Section title="Working Directory" icon={<FolderOpen size={14} className="text-text-muted" />}>
          {editingCwd ? (
            <input
              value={cwdDraft}
              onChange={(e) => setCwdDraft(e.target.value)}
              onBlur={handleCwdSave}
              onKeyDown={(e) => e.key === "Enter" && handleCwdSave()}
              autoFocus
              placeholder="e.g. D:\my-project"
              className="w-full px-3 py-2 bg-bg-primary border border-accent/30 rounded-md text-sm text-text-primary outline-none font-mono"
            />
          ) : (
            <button
              onClick={() => setEditingCwd(true)}
              className="w-full text-left px-3 py-2 bg-bg-surface rounded-md text-sm hover:bg-bg-hover transition-colors font-mono"
            >
              {task.cwd ? (
                <span className="text-text-primary">{task.cwd}</span>
              ) : (
                <span className="text-text-muted italic">No working directory set</span>
              )}
            </button>
          )}
        </Section>

        {/* Work Items */}
        <Section
          title="Work Items"
          icon={<ClipboardList size={14} className="text-text-muted" />}
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
          title="Pull Requests"
          icon={<GitPullRequest size={14} className="text-text-muted" />}
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
          title="Sessions"
          icon={<MessageSquare size={14} className="text-text-muted" />}
          count={task.sessionIds.length}
          summary={[
            busySessionCount > 0 ? `${busySessionCount} busy` : "",
            unreadSessionCount > 0 ? `${unreadSessionCount} unread` : "",
          ].filter(Boolean).join(" · ") || undefined}
        >
          <button
            onClick={async () => {
              const sessionId = await createTaskSession(task.id);
              onSessionCreated?.(sessionId);
              const updated = await fetchTask(task.id);
              setTask(updated);
              onTaskUpdated();
              onOpenSession(sessionId);
            }}
            className="w-full mb-2 px-3 py-2 bg-accent/10 text-accent border border-accent/20 rounded-md text-sm hover:bg-accent/20 transition-colors"
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
                  unread={!!isUnread?.(s.sessionId, s.modifiedTime)}
                  onOpen={() => onOpenSession(s.sessionId)}
                  onUnlink={() => handleUnlink({ type: "session", sessionId: s.sessionId })}
                  onArchive={onArchiveSession ? () => onArchiveSession(s.sessionId, !s.archived) : undefined}
                />
              ))}
            </div>
          )}
        </Section>

        {/* Notes */}
        <Section title="Notes" icon={<FileText size={14} className="text-text-muted" />}>
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
  const typeInfo = WI_TYPE_ICONS[item.type ?? ""] ?? { icon: <ClipboardList size={14} />, color: "text-text-muted" };
  const stateStyle = WI_STATE_STYLES[item.state ?? ""] ?? "bg-text-muted/15 text-text-muted";

  return (
    <div className="group flex items-start gap-2.5 px-3 py-2 bg-bg-surface rounded-md hover:bg-bg-hover transition-colors">
      <span className={`text-sm mt-0.5 ${typeInfo.color}`}>{typeInfo.icon}</span>
      <a
        href={item.url}
        target="_blank"
        rel="noopener"
        className="flex-1 min-w-0"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-accent hover:underline font-medium">
            #{item.id}
          </span>
          {item.title && (
            <span className="text-sm text-text-secondary truncate">
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
              <span className="text-[11px] text-text-muted truncate">
                {item.assignedTo}
              </span>
            )}
          </div>
        )}
      </a>
      <button
        onClick={(e) => { e.preventDefault(); onUnlink(); }}
        className="text-text-faint hover:text-error opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
        title="Unlink"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ── PR Row ────────────────────────────────────────────────────────

function PRRow({ item, onUnlink }: { item: EnrichedPR; onUnlink: () => void }) {
  const statusInfo = PR_STATUS_STYLES[item.status ?? ""] ?? PR_STATUS_STYLES.active;

  return (
    <div className="group flex items-start gap-2.5 px-3 py-2 bg-bg-surface rounded-md hover:bg-bg-hover transition-colors">
      <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${statusInfo.dot}`} />
      <a
        href={item.url}
        target="_blank"
        rel="noopener"
        className="flex-1 min-w-0"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-accent hover:underline font-medium">
            PR #{item.prId}
          </span>
          {item.title && (
            <span className="text-sm text-text-secondary truncate">
              {item.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-text-muted">
            {item.repoName || item.repoId}
          </span>
          {item.status && (
            <span className={`text-[10px] ${statusInfo.text}`}>
              {statusInfo.label}
            </span>
          )}
          {item.reviewerCount > 0 && (
            <span className="text-[10px] text-text-muted">
              {item.reviewerCount} reviewer{item.reviewerCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </a>
      <button
        onClick={(e) => { e.preventDefault(); onUnlink(); }}
        className="text-text-faint hover:text-error opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
        title="Unlink"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ── Session Row ───────────────────────────────────────────────────

function SessionRow({
  session,
  unread,
  onOpen,
  onUnlink,
  onArchive,
}: {
  session: Session;
  unread?: boolean;
  onOpen: () => void;
  onUnlink: () => void;
  onArchive?: () => void;
}) {
  const isArch = session.archived;
  // Dot: busy (blue pulsing) > unread (green solid) > archived (dark) > read (gray)
  const dotColor = session.busy
    ? "bg-info animate-pulse"
    : unread
      ? "bg-success"
      : isArch
        ? "bg-text-faint"
        : "bg-text-faint";

  return (
    <div className={`group flex items-start gap-2.5 px-3 py-2 bg-bg-surface rounded-md hover:bg-bg-hover transition-colors ${isArch ? "opacity-50" : ""}`}>
      <div className="mt-1 shrink-0">
        <span className={`inline-block w-2 h-2 rounded-full ${dotColor}`} />
      </div>
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 text-left"
      >
        <div className="text-sm text-accent hover:underline font-medium truncate">
          {session.summary || session.sessionId.slice(0, 8)}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-text-muted">
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
              <ClipboardList size={10} className="inline" />
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
      {onArchive && (
        <button
          onClick={onArchive}
          className="text-text-faint hover:text-warning opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
          title={isArch ? "Unarchive" : "Archive"}
        >
          {isArch ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </button>
      )}
      <button
        onClick={onUnlink}
        className="text-text-faint hover:text-error opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
        title="Unlink"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ── Skeleton loading row ──────────────────────────────────────────

function SkeletonRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 bg-bg-surface rounded-md">
      <span className="text-sm text-text-muted">{label}</span>
      <div className="flex-1 flex items-center gap-2">
        <div className="h-3 w-32 bg-bg-elevated rounded animate-pulse" />
        <div className="h-3 w-16 bg-bg-elevated rounded animate-pulse" />
      </div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────

function Section({
  title,
  icon,
  count,
  summary,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  count?: number;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-text-muted mb-2 flex items-center gap-2">
        {icon}
        <span>
          {title}
          {count !== undefined && (
            <span className="text-text-faint ml-1">({count})</span>
          )}
        </span>
        {summary && (
          <span className="text-[10px] text-text-muted font-normal">
            {summary}
          </span>
        )}
      </h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-text-faint px-3 py-2">{children}</div>;
}
