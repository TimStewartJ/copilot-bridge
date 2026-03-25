import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { Task, TaskGroup, Session, EnrichedWorkItem, EnrichedPR, Schedule, Todo } from "../api";
import { GROUP_COLOR_DOT } from "../group-colors";
import { fetchEnrichedTask, unlinkResource, fetchSchedules, patchSchedule, deleteSchedule, triggerSchedule, patchTask, fetchTodos, createTodo, patchTodo, deleteTodo } from "../api";
import { deadlineLabel, deadlineUrgency, DEADLINE_STYLES, CHECKBOX_URGENCY } from "../todo-helpers";
import SessionList from "./SessionList";
import PullToRefresh from "./PullToRefresh";
import ScheduleEditorDialog from "./ScheduleEditorDialog";
import NotesSheet from "./NotesSheet";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  MessageSquare,
  MoreHorizontal,
  Bug,
  CheckSquare,
  BookOpen,
  Target,
  Trophy,
  GitPullRequest,
  ClipboardList,
  Clock,
  Play,
  Pause,
  Plus,
  Trash2,
  FolderOpen,
  Copy,
  Check,
  Pencil,
  X,
  ListChecks,
  CalendarDays,
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
  Feature: { icon: <Target size={12} className="text-agent" /> },
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
  active: "bg-accent",
  completed: "bg-success",
  abandoned: "bg-warning",
};



function SectionLabel({ label, count, progress }: { label: string; count?: number; progress?: string }) {
  return (
    <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-3 py-1">
      {label}
      {progress !== undefined && (
        <span className="text-text-faint ml-1">({progress})</span>
      )}
      {progress === undefined && count !== undefined && (
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
  scheduleVersion?: number;
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
  hasDraft?: (sessionId: string) => boolean;
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
  scheduleVersion,
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
  hasDraft,
  onMoveTaskToGroup,
  onRefresh,
}: TaskPanelProps) {
  // ── Inline editing state ─────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // ── Notes sheet state ────────────────────────────────────────
  const [notesSheetOpen, setNotesSheetOpen] = useState(false);
  const [notesStartEdit, setNotesStartEdit] = useState(false);

  // ── CWD editing state ──────────────────────────────────────
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwdDraft, setCwdDraft] = useState("");
  const [cwdCopied, setCwdCopied] = useState(false);

  // ── Enrichment state ─────────────────────────────────────────
  const [enrichedWIs, setEnrichedWIs] = useState<EnrichedWorkItem[]>([]);
  const [enrichedPRs, setEnrichedPRs] = useState<EnrichedPR[]>([]);

  // ── Schedules state ─────────────────────────────────────────
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  // ── Todos state ─────────────────────────────────────────────
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTodoText, setNewTodoText] = useState("");

  // ── Todo highlight (from dashboard navigation) ──────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlightTodoId, setHighlightTodoId] = useState<string | null>(null);

  useEffect(() => {
    const todoId = searchParams.get("todo");
    if (todoId) {
      setHighlightTodoId(todoId);
      setSearchParams((prev) => { prev.delete("todo"); return prev; }, { replace: true });
      const timer = setTimeout(() => setHighlightTodoId(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [searchParams]);

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
  }, [task?.id, scheduleVersion]);

  // Fetch todos for this task
  useEffect(() => {
    if (task) {
      fetchTodos(task.id).then(setTodos).catch(() => setTodos([]));
    } else {
      setTodos([]);
    }
  }, [task?.id, task?.updatedAt]);

  // Reset editing state when task changes
  useEffect(() => {
    setEditingTitle(false);
    setNotesSheetOpen(false);
    setNotesStartEdit(false);
    setEditingCwd(false);
  }, [task?.id]);

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
            hasDraft={hasDraft}
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
            hasDraft={hasDraft}
          />
        </div>

        {/* Checklist */}
        <div>
          <SectionLabel
            label="Checklist"
            count={todos.length > 0 ? undefined : 0}
            progress={todos.length > 0 ? `${todos.filter((t) => t.done).length}/${todos.length}` : undefined}
          />
          {todos.length > 0 && (
            <div className="space-y-0">
              {todos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  highlight={todo.id === highlightTodoId}
                  onUpdate={(updated) => setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))}
                  onDelete={(id) => setTodos((prev) => prev.filter((t) => t.id !== id))}
                />
              ))}
            </div>
          )}
          <div className="px-3 py-1">
            <input
              className="w-full text-xs bg-transparent border-none outline-none text-text-secondary placeholder:text-text-faint"
              placeholder="+ Add item…"
              value={newTodoText}
              onChange={(e) => setNewTodoText(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && newTodoText.trim()) {
                  const todo = await createTodo(task.id, newTodoText.trim());
                  setTodos((prev) => [...prev, todo]);
                  setNewTodoText("");
                }
              }}
            />
          </div>
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

        {/* Working Directory */}
        <div>
          <SectionLabel label="Working Directory" />
          <div className="px-3 py-1 group">
            {editingCwd ? (
              <input
                autoFocus
                className="w-full text-xs font-mono bg-bg-surface border border-border rounded px-2 py-1 text-text-primary outline-none focus:border-accent"
                value={cwdDraft}
                onChange={(e) => setCwdDraft(e.target.value)}
                onBlur={() => {
                  const trimmed = cwdDraft.trim();
                  if (trimmed !== (task.cwd ?? "")) {
                    patchTask(task.id, { cwd: trimmed || undefined as any }).then(() => onTasksChanged?.());
                  }
                  setEditingCwd(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingCwd(false);
                }}
                placeholder="e.g. D:\my-project"
              />
            ) : task.cwd ? (
              <div className="flex items-center gap-1.5">
                <FolderOpen size={12} className="text-text-faint shrink-0" />
                <span
                  className="text-xs font-mono text-text-muted truncate flex-1 cursor-pointer hover:text-text-primary transition-colors"
                  title={task.cwd}
                  onClick={() => { setCwdDraft(task.cwd ?? ""); setEditingCwd(true); }}
                >
                  {task.cwd}
                </span>
                <div className="hidden group-hover:flex items-center gap-0.5">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(task.cwd!);
                      setCwdCopied(true);
                      setTimeout(() => setCwdCopied(false), 1500);
                    }}
                    className="p-0.5 text-text-faint hover:text-text-primary transition-colors"
                    title="Copy path"
                  >
                    {cwdCopied ? <Check size={10} /> : <Copy size={10} />}
                  </button>
                  <button
                    onClick={() => { setCwdDraft(task.cwd ?? ""); setEditingCwd(true); }}
                    className="p-0.5 text-text-faint hover:text-text-primary transition-colors"
                    title="Edit"
                  >
                    <Pencil size={10} />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setCwdDraft(""); setEditingCwd(true); }}
                className="text-[10px] text-text-faint hover:text-accent transition-colors"
              >
                Set working directory…
              </button>
            )}
          </div>
        </div>

        {/* Notes */}
        <div>
          <SectionLabel label="Notes" />
          {task.notes ? (
            <div
              onClick={() => { setNotesStartEdit(false); setNotesSheetOpen(true); }}
              className="px-3 py-1.5 cursor-pointer hover:bg-bg-hover rounded-md transition-colors relative"
              title="Click to view notes"
            >
              <div className="max-h-16 overflow-hidden">
                <div className="prose prose-invert prose-xs max-w-none text-text-muted
                  prose-p:my-0.5 prose-headings:mt-1 prose-headings:mb-0.5 prose-headings:text-xs
                  prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0
                  prose-pre:hidden prose-table:hidden
                  prose-code:text-accent prose-code:text-[10px]
                  prose-a:text-accent prose-a:no-underline">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{task.notes}</ReactMarkdown>
                </div>
              </div>
              <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-bg-secondary to-transparent pointer-events-none rounded-b-md" />
            </div>
          ) : (
            <div className="px-3 py-1">
              <button
                onClick={() => { setNotesStartEdit(true); setNotesSheetOpen(true); }}
                className="text-[10px] text-text-faint hover:text-accent transition-colors"
              >
                Add notes…
              </button>
            </div>
          )}
        </div>

        {/* Notes Sheet */}
        {notesSheetOpen && (
          <NotesSheet
            notes={task.notes}
            startInEditMode={notesStartEdit}
            onSave={async (newNotes) => {
              await patchTask(task.id, { notes: newNotes });
              onTasksChanged?.();
            }}
            onClose={() => { setNotesSheetOpen(false); setNotesStartEdit(false); }}
          />
        )}
      </PullToRefresh>
    </div>
  );
}

// ── TodoRow (extracted so each row can own a ref) ─────────────────

function TodoRow({
  todo,
  highlight,
  onUpdate,
  onDelete,
}: {
  todo: Todo;
  highlight?: boolean;
  onUpdate: (todo: Todo) => void;
  onDelete: (id: string) => void;
}) {
  const dateRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const urgency = deadlineUrgency(todo.deadline, todo.done);

  useEffect(() => {
    if (highlight && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlight]);

  return (
    <div
      ref={rowRef}
      data-todo-id={todo.id}
      className={`flex items-start gap-1.5 px-3 py-1 group hover:bg-bg-hover rounded-md transition-colors ${
        highlight ? "animate-todo-highlight" : ""
      }`}
    >
      {/* Checkbox */}
      <button
        onClick={async () => {
          const updated = await patchTodo(todo.id, { done: !todo.done });
          onUpdate(updated);
        }}
        className={`mt-0.5 w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
          todo.done
            ? "bg-success/80 border-success/80 text-white"
            : CHECKBOX_URGENCY[urgency]
        }`}
      >
        {todo.done && <Check size={9} strokeWidth={3} />}
      </button>

      {/* Text + deadline badge */}
      <div className="flex-1 min-w-0">
        <span
          className={`text-xs break-words ${
            todo.done ? "text-text-faint line-through" : "text-text-secondary"
          }`}
        >
          {todo.text}
        </span>
        {todo.deadline && !todo.done && (
          <button
            onClick={async () => {
              const updated = await patchTodo(todo.id, { deadline: null });
              onUpdate(updated);
            }}
            className={`inline-flex items-center gap-0.5 ml-1.5 px-1 py-0.5 -my-0.5 rounded text-[10px] cursor-pointer hover:opacity-70 transition-opacity ${DEADLINE_STYLES[urgency]}`}
            title="Click to clear deadline"
          >
            {urgency === "overdue" && "⚠ "}{deadlineLabel(todo.deadline)}
            <X size={8} className="opacity-0 group-hover:opacity-100" />
          </button>
        )}
      </div>

      {/* Actions (visible on hover) */}
      <div className="hidden group-hover:flex items-center gap-0">
        <button
          onClick={() => {
            try { dateRef.current?.showPicker(); } catch { dateRef.current?.click(); }
          }}
          className="p-0.5 text-text-faint hover:text-accent transition-colors shrink-0"
          title="Set deadline"
        >
          <CalendarDays size={10} />
        </button>
        <button
          onClick={async () => {
            await deleteTodo(todo.id);
            onDelete(todo.id);
          }}
          className="p-0.5 text-text-faint hover:text-error transition-colors shrink-0"
          title="Remove"
        >
          <X size={10} />
        </button>
      </div>

      {/* Hidden date input — triggered programmatically via showPicker() */}
      <input
        ref={dateRef}
        type="date"
        className="sr-only"
        tabIndex={-1}
        value={todo.deadline ?? ""}
        onChange={async (e) => {
          const val = e.target.value || null;
          const updated = await patchTodo(todo.id, { deadline: val });
          onUpdate(updated);
        }}
      />
    </div>
  );
}
