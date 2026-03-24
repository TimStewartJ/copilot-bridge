import { useState, useEffect, useRef } from "react";
import type { Task, TaskGroup, Session, EnrichedWorkItem, EnrichedPR, Schedule } from "../api";
import { fetchEnrichedTask, unlinkResource, fetchSchedules, patchSchedule, deleteSchedule, triggerSchedule } from "../api";
import SessionList from "./SessionList";
import PullToRefresh from "./PullToRefresh";
import ScheduleEditorDialog from "./ScheduleEditorDialog";
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
  Clock,
  Play,
  Pause,
  Plus,
  Trash2,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) {
    // Future date
    const absDiff = -diff;
    if (absDiff < 60_000) return "in <1m";
    if (absDiff < 3_600_000) return `in ${Math.round(absDiff / 60_000)}m`;
    if (absDiff < 86_400_000) return `in ${Math.round(absDiff / 3_600_000)}h`;
    return `in ${Math.round(absDiff / 86_400_000)}d`;
  }
  if (diff < 60_000) return "<1m ago";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
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

const GROUP_COLOR_DOT: Record<string, string> = {
  blue: "bg-blue-500", purple: "bg-purple-500", green: "bg-green-500", amber: "bg-amber-500",
  rose: "bg-rose-500", cyan: "bg-cyan-500", orange: "bg-orange-500", slate: "bg-slate-500",
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
  taskGroups?: TaskGroup[];
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
  exitingIds?: Set<string>;
  // Quick Chats mode
  isQuickChats?: boolean;
  orphanSessions?: Session[];
  onNewQuickChat?: () => void;
  // Linking
  tasks?: Task[];
  onLinkToTask?: (sessionId: string, taskId: string) => void;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onRefresh?: () => Promise<void>;
}

// ── Component ────────────────────────────────────────────────────

export default function TaskPanel({
  task,
  taskGroups = [],
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onUpdateTask,
  onTasksChanged,
  isUnread,
  onArchiveSession,
  archivingIds,
  exitingIds,
  isQuickChats,
  orphanSessions,
  onNewQuickChat,
  tasks,
  onLinkToTask,
  onUnlinkFromTask,
  onDeleteTask,
  onDeleteSession,
  onMarkUnread,
  onMoveTaskToGroup,
  onRefresh,
}: TaskPanelProps) {
  // ── Inline editing state ─────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // ── Notes collapse state ─────────────────────────────────────
  const [notesExpanded, setNotesExpanded] = useState(false);

  // ── Enrichment state ─────────────────────────────────────────
  const [enrichedWIs, setEnrichedWIs] = useState<EnrichedWorkItem[]>([]);
  const [enrichedPRs, setEnrichedPRs] = useState<EnrichedPR[]>([]);

  // ── Schedules state ─────────────────────────────────────────
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  useEffect(() => {
    if (
      task &&
      (task.workItems.length > 0 || task.pullRequests.length > 0)
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
  }, [task?.id, task?.workItems.length, task?.pullRequests.length]);

  // Fetch schedules for this task
  useEffect(() => {
    if (task) {
      fetchSchedules(task.id).then(setSchedules).catch(() => setSchedules([]));
    } else {
      setSchedules([]);
    }
  }, [task?.id]);

  // Reset editing state when task changes
  useEffect(() => {
    setEditingTitle(false);
    setOverflowOpen(false);
    setConfirmDelete(false);
    setNotesExpanded(false);
  }, [task?.id]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [overflowOpen]);

  // ── Quick Chats mode ─────────────────────────────────────────
  if (!task && isQuickChats) {
    return (
      <div className="h-full w-full md:w-64 flex flex-col bg-bg-secondary border-r border-border min-w-0 overflow-hidden">
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
        <PullToRefresh onRefresh={onRefresh ?? (async () => {})} className="flex-1 overflow-x-hidden p-2 space-y-3">
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
            exitingIds={exitingIds}
            tasks={tasks}
            onLinkToTask={onLinkToTask}
            onDeleteSession={onDeleteSession}
            onMarkUnread={onMarkUnread}
          />
        </PullToRefresh>
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

  return (
    <div className="h-full w-full md:w-64 flex flex-col bg-bg-secondary border-r border-border min-w-0 overflow-hidden">
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

          {/* Group badge */}
          {(() => {
            const group = taskGroups.find((g) => g.id === task.groupId);
            if (!group) return null;
            const colorDot = GROUP_COLOR_DOT[group.color] ?? "bg-slate-500";
            return (
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-text-muted bg-bg-hover shrink-0" title={`Group: ${group.name}`}>
                <span className={`w-2 h-2 rounded-full ${colorDot}`} />
                <span className="truncate max-w-[80px]">{group.name}</span>
              </div>
            );
          })()}

          {/* Overflow menu */}
          <div className="relative shrink-0" ref={overflowRef}>
            <button
              onClick={() => { setOverflowOpen((v) => !v); setConfirmDelete(false); }}
              className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
              title="More options"
            >
              <MoreHorizontal size={14} />
            </button>
            {overflowOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-bg-elevated border border-border rounded-lg shadow-lg py-1 min-w-[120px]">
                {!confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-bg-hover transition-colors"
                  >
                    Delete task
                  </button>
                ) : (
                  <div className="px-3 py-2">
                    <div className="text-xs text-text-muted mb-2">Delete this task?</div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          onDeleteTask?.(task.id);
                          setOverflowOpen(false);
                          setConfirmDelete(false);
                        }}
                        className="px-2 py-1 text-xs bg-error/15 text-error hover:bg-error/25 rounded transition-colors"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="px-2 py-1 text-xs text-text-muted hover:bg-bg-hover rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable content */}
      <PullToRefresh onRefresh={onRefresh ?? (async () => {})} className="flex-1 overflow-x-hidden p-2 space-y-3">
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
            exitingIds={exitingIds}
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
            onDeleteSession={onDeleteSession}
            onMarkUnread={onMarkUnread}
          />
        </div>

        {/* Work Items */}
        {task.workItems.length > 0 && (
          <div>
            <SectionLabel label="Work Items" count={task.workItems.length} />
            <div className="space-y-0.5">
              {(enrichedWIs.length > 0
                ? enrichedWIs
                : task.workItems.map((w) => ({
                    id: w.id,
                    provider: w.provider,
                    title: null,
                    state: null,
                    type: null,
                    assignedTo: null,
                    areaPath: null,
                    url: "#",
                  }))
              ).map((wi) => (
                <a
                  key={`${wi.provider}-${wi.id}`}
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
                    provider: pr.provider,
                    title: null,
                    status: null as any,
                    createdBy: null,
                    reviewerCount: 0,
                    url: "#",
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

        {/* Schedules */}
        <div>
          <div className="flex items-center justify-between px-3 py-1">
            <SectionLabel label="Schedules" count={schedules.length} />
            <button
              onClick={() => { setEditingSchedule(null); setScheduleEditorOpen(true); }}
              className="text-[10px] text-accent hover:text-accent-hover transition-colors flex items-center gap-0.5"
              title="Add schedule"
            >
              <Plus size={10} />
              <span>Add</span>
            </button>
          </div>
          {schedules.length > 0 ? (
            <div className="space-y-0.5">
              {schedules.map((schedule) => (
                <div
                  key={schedule.id}
                  className="px-3 py-1.5 text-xs hover:bg-bg-hover rounded-md transition-colors group"
                >
                  <div className="flex items-center gap-1.5">
                    <Clock size={12} className={schedule.enabled ? "text-accent" : "text-text-faint"} />
                    <span className={`font-medium truncate flex-1 ${schedule.enabled ? "text-text-primary" : "text-text-faint line-through"}`}>
                      {schedule.name}
                    </span>
                    <div className="hidden group-hover:flex items-center gap-0.5">
                      <button
                        onClick={async () => {
                          await triggerSchedule(schedule.id);
                          fetchSchedules(task.id).then(setSchedules).catch(() => {});
                        }}
                        className="p-0.5 text-text-muted hover:text-success transition-colors"
                        title="Run now"
                      >
                        <Play size={10} />
                      </button>
                      <button
                        onClick={async () => {
                          await patchSchedule(schedule.id, { enabled: !schedule.enabled });
                          fetchSchedules(task.id).then(setSchedules).catch(() => {});
                        }}
                        className="p-0.5 text-text-muted hover:text-warning transition-colors"
                        title={schedule.enabled ? "Pause" : "Resume"}
                      >
                        <Pause size={10} />
                      </button>
                      <button
                        onClick={() => { setEditingSchedule(schedule); setScheduleEditorOpen(true); }}
                        className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
                        title="Edit"
                      >
                        <MoreHorizontal size={10} />
                      </button>
                      <button
                        onClick={async () => {
                          await deleteSchedule(schedule.id);
                          fetchSchedules(task.id).then(setSchedules).catch(() => {});
                        }}
                        className="p-0.5 text-text-muted hover:text-error transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-0.5 ml-5 text-[10px] text-text-faint">
                    {schedule.type === "cron" ? schedule.cron : `Once at ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "?"}`}
                    {schedule.lastRunAt && ` · Last: ${timeAgo(schedule.lastRunAt)}`}
                    {schedule.nextRunAt && ` · Next: ${timeAgo(schedule.nextRunAt)}`}
                    {schedule.runCount > 0 && ` · ${schedule.runCount} run${schedule.runCount !== 1 ? "s" : ""}`}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 text-[10px] text-text-faint">
              No schedules — add one to automate recurring work
            </div>
          )}
        </div>

        {/* Schedule Editor Dialog */}
        {scheduleEditorOpen && (
          <ScheduleEditorDialog
            taskId={task.id}
            schedule={editingSchedule}
            onClose={() => { setScheduleEditorOpen(false); setEditingSchedule(null); }}
            onSaved={() => {
              setScheduleEditorOpen(false);
              setEditingSchedule(null);
              fetchSchedules(task.id).then(setSchedules).catch(() => {});
            }}
          />
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
      </PullToRefresh>
    </div>
  );
}
