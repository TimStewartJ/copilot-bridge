import { useState, useEffect } from "react";
import type { Task, Session, EnrichedWorkItem, EnrichedPR } from "../api";
import { fetchEnrichedTask, unlinkResource } from "../api";
import SessionList from "./SessionList";
import {
  MessageSquare,
  MoreHorizontal,
  Bug,
  CheckSquare,
  BookOpen,
  Target,
  Trophy,
  GitPullRequest,
  ChevronDown,
  ChevronRight,
  ClipboardList,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  active: "bg-success/15 text-success",
  paused: "bg-warning/15 text-warning",
  done: "bg-text-muted/15 text-text-muted",
  archived: "bg-text-faint/15 text-text-faint",
};

const STATUS_CYCLE: Record<string, Task["status"]> = {
  active: "paused",
  paused: "done",
  done: "active",
};

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

// ── Props ────────────────────────────────────────────────────────

interface TaskPanelProps {
  // Task mode
  task: Task | null;
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: Partial<Pick<Task, "title" | "status">>,
  ) => void;
  onTasksChanged?: () => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  onArchiveSession?: (id: string, archived: boolean) => void;
  archivingIds?: Set<string>;
  // Quick Chats mode
  isQuickChats?: boolean;
  orphanSessions?: Session[];
  onNewQuickChat?: () => void;
  // Linking
  tasks?: Task[];
  onLinkToTask?: (sessionId: string, taskId: string) => void;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
}

// ── Component ────────────────────────────────────────────────────

export default function TaskPanel({
  task,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onUpdateTask,
  onTasksChanged,
  isUnread,
  onArchiveSession,
  archivingIds,
  isQuickChats,
  orphanSessions,
  onNewQuickChat,
  tasks,
  onLinkToTask,
  onUnlinkFromTask,
}: TaskPanelProps) {
  // ── Inline editing state ─────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // ── Notes collapse state ─────────────────────────────────────
  const [notesExpanded, setNotesExpanded] = useState(false);

  // ── Enrichment state ─────────────────────────────────────────
  const [enrichedWIs, setEnrichedWIs] = useState<EnrichedWorkItem[]>([]);
  const [enrichedPRs, setEnrichedPRs] = useState<EnrichedPR[]>([]);

  useEffect(() => {
    if (
      task &&
      (task.workItemIds.length > 0 || task.pullRequests.length > 0)
    ) {
      fetchEnrichedTask(task.id)
        .then((data) => {
          setEnrichedWIs(data.workItems);
          setEnrichedPRs(data.pullRequests);
        })
        .catch(() => {});
    } else {
      setEnrichedWIs([]);
      setEnrichedPRs([]);
    }
  }, [task?.id, task?.workItemIds.length, task?.pullRequests.length]);

  // Reset editing state when task changes
  useEffect(() => {
    setEditingTitle(false);
    setNotesExpanded(false);
  }, [task?.id]);

  // ── Quick Chats mode ─────────────────────────────────────────
  if (!task && isQuickChats) {
    return (
      <div className="h-full w-full md:w-64 flex flex-col bg-bg-secondary border-r border-border">
        {/* Header */}
        <div className="p-3 border-b border-border">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-text-muted" />
            <span className="text-sm font-semibold text-text-primary">
              Quick Chats
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          <SessionList
            variant="global"
            sessions={orphanSessions ?? []}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onNewSession={onNewQuickChat ?? (() => {})}
            newButtonLabel="+ Quick Chat"
            isUnread={isUnread}
            onArchiveSession={onArchiveSession}
            archivingIds={archivingIds}
            tasks={tasks}
            onLinkToTask={onLinkToTask}
          />
        </div>
      </div>
    );
  }

  // ── No task selected (empty state) ───────────────────────────
  if (!task) {
    return (
      <div className="h-full w-full md:w-64 flex flex-col bg-bg-secondary border-r border-border items-center justify-center">
        <span className="text-xs text-text-faint">Select a task</span>
      </div>
    );
  }

  // ── Task mode ────────────────────────────────────────────────

  const linkedSessions = sessions.filter((s) =>
    task.sessionIds.includes(s.sessionId),
  );

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdateTask(task.id, { title: trimmed });
    }
    setEditingTitle(false);
  };

  const cycleStatus = () => {
    const next = STATUS_CYCLE[task.status];
    if (next) onUpdateTask(task.id, { status: next });
  };

  return (
    <div className="h-full w-full md:w-64 flex flex-col bg-bg-secondary border-r border-border">
      {/* Header — inline task editing */}
      <div className="p-3 border-b border-border">
        <div className="flex items-start gap-2">
          {/* Title (click-to-edit) */}
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                autoFocus
                className="w-full text-sm font-medium bg-bg-surface border border-border rounded px-1.5 py-0.5 text-text-primary outline-none focus:border-accent"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
              />
            ) : (
              <button
                onClick={() => {
                  setTitleDraft(task.title);
                  setEditingTitle(true);
                }}
                className="text-sm font-medium text-text-primary hover:text-accent leading-tight line-clamp-2 text-left transition-colors w-full"
                title="Click to edit title"
              >
                {task.title}
              </button>
            )}
          </div>

          {/* Status badge */}
          <button
            onClick={cycleStatus}
            className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 cursor-pointer transition-colors ${STATUS_COLORS[task.status] ?? ""}`}
            title={`Status: ${task.status} — click to cycle`}
          >
            {task.status}
          </button>

          {/* Overflow menu */}
          <button
            className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors shrink-0"
            title="More options"
          >
            <MoreHorizontal size={14} />
          </button>
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
            newButtonLabel="+ New Chat"
            isUnread={isUnread}
            onArchiveSession={onArchiveSession}
            archivingIds={archivingIds}
            taskContext={task}
            onUnlinkFromTask={
              onUnlinkFromTask
                ? onUnlinkFromTask
                : async (sessionId, taskId) => {
                    await unlinkResource(taskId, {
                      type: "session",
                      sessionId,
                    });
                    onTasksChanged?.();
                  }
            }
          />
        </div>

        {/* Work Items */}
        {task.workItemIds.length > 0 && (
          <div>
            <SectionLabel label="Work Items" count={task.workItemIds.length} />
            <div className="space-y-0.5">
              {(enrichedWIs.length > 0
                ? enrichedWIs
                : task.workItemIds.map((id) => ({
                    id,
                    title: null,
                    state: null,
                    type: null,
                    assignedTo: null,
                    areaPath: null,
                    url: `https://my-org.visualstudio.com/MyProject/_workitems/edit/${id}`,
                  }))
              ).map((wi) => (
                <a
                  key={wi.id}
                  href={wi.url}
                  target="_blank"
                  rel="noopener"
                  className="block px-3 py-1.5 text-xs text-accent hover:text-accent-hover hover:bg-bg-hover rounded-md transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span>
                      {WI_TYPE_ICONS[wi.type ?? ""]?.icon ?? (
                        <ClipboardList size={12} />
                      )}
                    </span>
                    <span className="font-medium">#{wi.id}</span>
                    {wi.title && (
                      <span className="text-text-muted truncate">
                        {wi.title}
                      </span>
                    )}
                  </div>
                  {wi.state && (
                    <div className="mt-0.5 ml-5">
                      <span
                        className={`text-[9px] px-1 py-0.5 rounded-full ${WI_STATE_STYLES[wi.state] ?? "bg-text-muted/15 text-text-muted"}`}
                      >
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
            <SectionLabel
              label="Pull Requests"
              count={task.pullRequests.length}
            />
            <div className="space-y-0.5">
              {(enrichedPRs.length > 0
                ? enrichedPRs
                : task.pullRequests.map((pr) => ({
                    repoId: pr.repoId,
                    repoName: pr.repoName ?? null,
                    prId: pr.prId,
                    title: null,
                    status: null as any,
                    createdBy: null,
                    reviewerCount: 0,
                    url: `https://my-org.visualstudio.com/MyProject/_git/${pr.repoName ?? pr.repoId}/pullrequest/${pr.prId}`,
                  }))
              ).map((pr) => (
                <a
                  key={`${pr.repoId}-${pr.prId}`}
                  href={pr.url}
                  target="_blank"
                  rel="noopener"
                  className="block px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    {pr.status && (
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${PR_STATUS_DOTS[pr.status] ?? "bg-text-muted"}`}
                      />
                    )}
                    {!pr.status && (
                      <GitPullRequest size={12} className="text-text-muted" />
                    )}
                    <span className="text-accent font-medium">
                      #{pr.prId}
                    </span>
                    {pr.title && (
                      <span className="text-text-muted truncate">
                        {pr.title}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 ml-5 text-[10px] text-text-faint">
                    {pr.repoName || pr.repoId}
                    {pr.status &&
                      ` · ${pr.status.charAt(0).toUpperCase() + pr.status.slice(1)}`}
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
                {notesExpanded ? (
                  <ChevronDown size={10} />
                ) : (
                  <ChevronRight size={10} />
                )}
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
    </div>
  );
}
