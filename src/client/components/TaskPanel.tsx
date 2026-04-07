import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { Task, TaskGroup, Session, Todo, Tag } from "../api";
import { GROUP_COLOR_DOT } from "../group-colors";
import { unlinkResource, patchTask, fetchTodos, createTodo } from "../api";
import TodoRow from "./TodoRow";
import { timeAgo } from "../time";
import { WI_TYPE_ICONS, WI_STATE_STYLES, PR_STATUS_STYLES } from "../work-item-styles";
import { useTaskEnrichment } from "../hooks/useTaskEnrichment";
import { useTaskSchedules } from "../hooks/useTaskSchedules";
import { useNotesSheet } from "../hooks/useNotesSheet";

import SessionList from "./SessionList";
import PullToRefresh from "./PullToRefresh";
import ScheduleEditorDialog from "./ScheduleEditorDialog";
import NotesSheet from "./NotesSheet";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { TagPillList } from "./TagPill";
import TagPicker from "./TagPicker";
import {
  MoreHorizontal,
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
  ListChecks,
  LayoutDashboard,
} from "lucide-react";
import CollapsibleCompleted from "./shared/CollapsibleCompleted";

// ── Compact section header for sidebar ───────────────────────────



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
  // Linking
  tasks?: Task[];
  onLinkToTask?: (sessionId: string, taskId: string) => void;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onDuplicateSession?: (sessionId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  hasDraft?: (sessionId: string) => boolean;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onRefresh?: () => Promise<void>;
  onViewDashboard?: (taskId: string) => void;
  // Bulk actions
  onMarkAllRead?: () => void;
  onBulkAction?: (action: import("../api").BatchAction, sessionIds: string[]) => void;
  // Lazy-load archived sessions
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  // Tags
  allTags?: Tag[];
  onSetTaskTags?: (taskId: string, tagIds: string[]) => void;
  onTagCreated?: (tag: Tag) => void;
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
  tasks,
  onLinkToTask,
  onUnlinkFromTask,
  onDeleteTask,
  onDeleteSession,
  onDuplicateSession,
  onMarkUnread,
  hasDraft,
  onMoveTaskToGroup,
  onRefresh,
  onViewDashboard,
  onMarkAllRead,
  onBulkAction,
  onRequestArchived,
  archivedLoaded,
  allTags = [],
  onSetTaskTags,
  onTagCreated,
}: TaskPanelProps) {
  // ── Inline editing state ─────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // ── Notes sheet (shared hook) ────────────────────────────────
  const notes = useNotesSheet(task?.id);

  // ── CWD editing state ──────────────────────────────────────
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwdDraft, setCwdDraft] = useState("");
  const [cwdCopied, setCwdCopied] = useState(false);

  // ── Enrichment (shared hook) ─────────────────────────────────
  const { enrichedWIs, enrichedPRs } = useTaskEnrichment(
    task?.id, task?.workItems.length ?? 0, task?.pullRequests.length ?? 0,
  );

  // ── Schedules (shared hook) ─────────────────────────────────
  const sched = useTaskSchedules(task?.id, scheduleVersion);

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
    setEditingCwd(false);
  }, [task?.id]);

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
        {/* Dashboard link */}
        {onViewDashboard && (
          <button
            onClick={() => onViewDashboard(task.id)}
            className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-accent transition-colors mb-1.5"
          >
            <LayoutDashboard size={10} />
            <span>Task Overview</span>
          </button>
        )}
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
        {/* Tags */}
        {(() => {
          const taskOwnTags = task.tags ?? [];
          const group = taskGroups.find((g) => g.id === task.groupId);
          const groupTags = group?.tags ?? [];
          const inheritedTagIds = new Set(groupTags.map((t) => t.id));
          const effectiveTags = [
            ...taskOwnTags,
            ...groupTags.filter((gt) => !taskOwnTags.some((tt) => tt.id === gt.id)),
          ];
          if (effectiveTags.length === 0 && !onSetTaskTags) return null;
          return (
            <div className="flex items-center gap-1 flex-wrap px-3 pb-2">
              <TagPillList
                tags={effectiveTags}
                inheritedTagIds={inheritedTagIds}
                onRemove={onSetTaskTags ? (tagId) => {
                  const newIds = taskOwnTags.filter((t) => t.id !== tagId).map((t) => t.id);
                  onSetTaskTags(task.id, newIds);
                } : undefined}
                max={4}
              />
              {onSetTaskTags && (
                <TagPicker
                  allTags={allTags}
                  selectedTagIds={taskOwnTags.map((t) => t.id)}
                  inheritedTagIds={inheritedTagIds}
                  onChange={(tagIds) => onSetTaskTags(task.id, tagIds)}
                  onTagCreated={onTagCreated}
                  compact
                />
              )}
            </div>
          );
        })()}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 relative">
      <PullToRefresh onRefresh={onRefresh ?? (async () => {})} className="absolute inset-0 overflow-x-hidden p-2 space-y-3">
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
            onDuplicateSession={onDuplicateSession}
            onMarkUnread={onMarkUnread}
            hasDraft={hasDraft}
            onRequestArchived={onRequestArchived}
            archivedLoaded={archivedLoaded}
          />
        </div>

        {/* Checklist */}
        <div>
          <SectionLabel
            label="Checklist"
            count={todos.length > 0 ? undefined : 0}
            progress={todos.length > 0 ? `${todos.filter((t) => t.done).length}/${todos.length}` : undefined}
          />
          {(() => {
            const openTodos = todos.filter((t) => !t.done);
            const doneTodos = todos.filter((t) => t.done);
            return (
              <>
                {openTodos.length > 0 && (
                  <div className="space-y-0">
                    {openTodos.map((todo) => (
                      <TodoRow
                        key={todo.id}
                        variant="panel"
                        todo={todo}
                        highlight={todo.id === highlightTodoId}
                        onUpdate={(updated) => setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))}
                        onDelete={(id) => setTodos((prev) => prev.filter((t) => t.id !== id))}
                      />
                    ))}
                  </div>
                )}
                {doneTodos.length > 0 && (
                  <CollapsibleCompleted count={doneTodos.length}>
                    <div className="space-y-0">
                      {doneTodos.map((todo) => (
                        <TodoRow
                          key={todo.id}
                          variant="panel"
                          todo={todo}
                          highlight={todo.id === highlightTodoId}
                          onUpdate={(updated) => setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))}
                          onDelete={(id) => setTodos((prev) => prev.filter((t) => t.id !== id))}
                        />
                      ))}
                    </div>
                  </CollapsibleCompleted>
                )}
              </>
            );
          })()}
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
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${PR_STATUS_STYLES[pr.status]?.dot ?? "bg-text-muted"}`}
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
            <SectionLabel label="Schedules" count={sched.schedules.length} />
            <button
              onClick={() => sched.openEditor()}
              className="text-[10px] text-accent hover:text-accent-hover transition-colors flex items-center gap-0.5"
              title="Add schedule"
            >
              <Plus size={10} />
              <span>Add</span>
            </button>
          </div>
          {sched.schedules.length > 0 ? (() => {
            const activeSchedules = sched.schedules.filter((s) => s.enabled);
            const disabledSchedules = sched.schedules.filter((s) => !s.enabled);
            const renderScheduleRow = (schedule: typeof sched.schedules[0]) => (
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
                      onClick={() => sched.trigger(schedule.id)}
                      className="p-0.5 text-text-muted hover:text-success transition-colors"
                      title="Run now"
                    >
                      <Play size={10} />
                    </button>
                    <button
                      onClick={() => sched.toggle(schedule)}
                      className="p-0.5 text-text-muted hover:text-warning transition-colors"
                      title={schedule.enabled ? "Pause" : "Resume"}
                    >
                      <Pause size={10} />
                    </button>
                    <button
                      onClick={() => sched.openEditor(schedule)}
                      className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
                      title="Edit"
                    >
                      <MoreHorizontal size={10} />
                    </button>
                    <button
                      onClick={() => sched.remove(schedule.id)}
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
            );
            return (
              <div className="space-y-0.5">
                {activeSchedules.map(renderScheduleRow)}
                <CollapsibleCompleted count={disabledSchedules.length} label="disabled">
                  {disabledSchedules.map(renderScheduleRow)}
                </CollapsibleCompleted>
              </div>
            );
          })() : (
            <div className="px-3 py-2 text-[10px] text-text-faint">
              No schedules — add one to automate recurring work
            </div>
          )}
        </div>

        {/* Schedule Editor Dialog */}
        {sched.scheduleEditorOpen && (
          <ScheduleEditorDialog
            taskId={task.id}
            schedule={sched.editingSchedule}
            onClose={sched.closeEditor}
            onSaved={sched.onSaved}
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
              onClick={notes.openToView}
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
                onClick={notes.openToEdit}
                className="text-[10px] text-text-faint hover:text-accent transition-colors"
              >
                Add notes…
              </button>
            </div>
          )}
        </div>

        {/* Notes Sheet */}
        {notes.notesSheetOpen && (
          <NotesSheet
            notes={task.notes}
            startInEditMode={notes.notesStartEdit}
            onSave={async (newNotes) => {
              await patchTask(task.id, { notes: newNotes });
              onTasksChanged?.();
            }}
            onClose={notes.close}
          />
        )}
      </PullToRefresh>
      </div>
    </div>
  );
}
