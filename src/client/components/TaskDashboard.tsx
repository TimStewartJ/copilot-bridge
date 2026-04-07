import { useState, useEffect, useCallback } from "react";
import type { Task, TaskGroup, Session, Todo, Tag, RelatedDoc } from "../api";
import { patchTask, fetchTodos, createTodo, unlinkResource, fetchRelatedDocs } from "../api";
import TodoRow from "./TodoRow";
import { GROUP_COLOR_DOT } from "../group-colors";
import { timeAgo } from "../time";
import { WI_TYPE_ICONS, WI_STATE_STYLES, PR_STATUS_STYLES } from "../work-item-styles";
import { useTaskEnrichment } from "../hooks/useTaskEnrichment";
import { useTaskSchedules } from "../hooks/useTaskSchedules";
import { useNotesSheet } from "../hooks/useNotesSheet";
import EmptyState from "./shared/EmptyState";
import PullToRefresh from "./PullToRefresh";
import SessionList from "./SessionList";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import NotesSheet from "./NotesSheet";
import ScheduleEditorDialog from "./ScheduleEditorDialog";
import { TagPillList } from "./TagPill";
import TagPicker from "./TagPicker";
import {
  MessageSquare,
  Plus,
  GitPullRequest,
  ClipboardList,
  Clock,
  Play,
  Pause,
  Trash2,
  FolderOpen,
  Pencil,
  MoreHorizontal,
  StickyNote,
  CheckSquare,
  LayoutDashboard,
  BookOpen,
} from "lucide-react";
import CollapsibleCompleted from "./shared/CollapsibleCompleted";

// ── Props ────────────────────────────────────────────────────────

interface TaskDashboardProps {
  task: Task;
  taskGroups?: TaskGroup[];
  sessions: Session[];
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => void;
  onTasksChanged?: () => void;
  scheduleVersion?: number;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  allTags?: Tag[];
  onSetTaskTags?: (taskId: string, tagIds: string[]) => void;
  onTagCreated?: (tag: Tag) => void;
  onRefresh?: () => Promise<void>;
  // Session actions (for context menu)
  onDeleteSession?: (sessionId: string) => void;
  onDuplicateSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  hasDraft?: (sessionId: string) => boolean;
  // Lazy-load archived sessions
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
}

// ── Component ────────────────────────────────────────────────────

export default function TaskDashboard({
  task,
  taskGroups = [],
  sessions,
  onSelectSession,
  onNewSession,
  onUpdateTask,
  onTasksChanged,
  scheduleVersion,
  isUnread,
  allTags = [],
  onSetTaskTags,
  onTagCreated,
  onRefresh,
  onDeleteSession,
  onDuplicateSession,
  onArchiveSession,
  onUnlinkFromTask,
  onMarkUnread,
  hasDraft,
  onRequestArchived,
  archivedLoaded,
}: TaskDashboardProps) {
  // ── Shared hooks ─────────────────────────────────────────────
  const { enrichedWIs, enrichedPRs, reload: reloadEnriched } = useTaskEnrichment(
    task.id, task.workItems.length, task.pullRequests.length,
  );
  const sched = useTaskSchedules(task.id, scheduleVersion);
  const notes = useNotesSheet(task.id);

  // ── Todos ───────────────────────────────────────────────────
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTodoText, setNewTodoText] = useState("");

  useEffect(() => {
    fetchTodos(task.id).then(setTodos).catch(() => setTodos([]));
  }, [task.id]);

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      fetchTodos(task.id).then(setTodos).catch(() => setTodos([])),
      reloadEnriched(),
      sched.reload(),
      onRefresh?.(),
    ]);
  }, [task.id, reloadEnriched, sched.reload, onRefresh]);

  const linkedSessions = sessions.filter((s) =>
    task.sessionIds.includes(s.sessionId)
  );
  const group = taskGroups.find((g) => g.id === task.groupId);
  const taskOwnTags = task.tags ?? [];
  const groupTags = group?.tags ?? [];
  const inheritedTagIds = new Set(groupTags.map((t) => t.id));
  const effectiveTags = [
    ...taskOwnTags,
    ...groupTags.filter((gt) => !taskOwnTags.some((tt) => tt.id === gt.id)),
  ];

  const openTodos = todos.filter((t) => !t.done);
  const doneTodos = todos.filter((t) => t.done);

  // ── Related Docs ─────────────────────────────────────────────
  const [relatedDocs, setRelatedDocs] = useState<RelatedDoc[]>([]);
  useEffect(() => {
    const tagIds = effectiveTags.map((t) => t.id);
    if (tagIds.length === 0) { setRelatedDocs([]); return; }
    fetchRelatedDocs(tagIds).then(setRelatedDocs).catch(() => setRelatedDocs([]));
  }, [effectiveTags.map((t) => t.id).join(",")]);

  return (
    <PullToRefresh onRefresh={handleRefresh} className="flex-1">
      <div className="max-w-4xl mx-auto px-4 md:px-8 py-6 space-y-6">
        {/* ── Task Header ─────────────────────────────────── */}
        <div>
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <LayoutDashboard size={16} className="text-text-muted shrink-0" />
                {group && (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-text-muted bg-bg-hover shrink-0">
                    <span className={`w-2 h-2 rounded-full ${GROUP_COLOR_DOT[group.color] ?? "bg-slate-500"}`} />
                    <span>{group.name}</span>
                  </div>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${
                  task.status === "active" ? "bg-success/15 text-success" :
                  task.status === "paused" ? "bg-warning/15 text-warning" :
                  task.status === "done" ? "bg-accent/15 text-accent" :
                  "bg-text-muted/15 text-text-muted"
                }`}>
                  {task.status}
                </span>
              </div>
              <h1 className="text-xl font-semibold text-text-primary leading-tight">
                {task.title}
              </h1>
              {/* Tags */}
              {(effectiveTags.length > 0 || onSetTaskTags) && (
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <TagPillList
                    tags={effectiveTags}
                    inheritedTagIds={inheritedTagIds}
                    size="sm"
                    onRemove={onSetTaskTags ? (tagId) => {
                      const newIds = taskOwnTags.filter((t) => t.id !== tagId).map((t) => t.id);
                      onSetTaskTags(task.id, newIds);
                    } : undefined}
                  />
                  {onSetTaskTags && (
                    <TagPicker
                      allTags={allTags}
                      selectedTagIds={taskOwnTags.map((t) => t.id)}
                      inheritedTagIds={inheritedTagIds}
                      onChange={(tagIds) => onSetTaskTags(task.id, tagIds)}
                      onTagCreated={onTagCreated}
                    />
                  )}
                </div>
              )}
              {task.cwd && (
                <div className="flex items-center gap-1.5 mt-1.5 text-xs text-text-muted">
                  <FolderOpen size={12} className="text-text-faint" />
                  <span className="font-mono">{task.cwd}</span>
                </div>
              )}
              <div className="text-xs text-text-faint mt-1">
                Updated {timeAgo(task.updatedAt)} · Created {timeAgo(task.createdAt)}
              </div>
            </div>
            <button
              onClick={() => onNewSession(task.id)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5 shrink-0"
            >
              <Plus size={12} />
              New Chat
            </button>
          </div>
        </div>

        {/* ── Two-column grid ─────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Left Column ─────────────────────────────── */}
          <div className="space-y-6">
            {/* Sessions */}
            <Section
              icon={<MessageSquare size={14} />}
              title="Sessions"
              count={linkedSessions.filter((s) => !s.archived).length}
              action={
                <button
                  onClick={() => onNewSession(task.id)}
                  className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                >
                  <Plus size={12} /> New
                </button>
              }
            >
              {linkedSessions.length === 0 ? (
                <EmptyState message="No sessions yet" sub="Start a chat to begin working" />
              ) : (
                <SessionList
                  variant="compact"
                  sessions={linkedSessions}
                  activeSessionId={null}
                  onSelectSession={onSelectSession}
                  onNewSession={() => onNewSession(task.id)}
                  showEmptyState={false}
                  isUnread={isUnread}
                  onArchiveSession={onArchiveSession}
                  taskContext={task}
                  onUnlinkFromTask={
                    onUnlinkFromTask
                      ?? (async (sessionId, taskId) => {
                           await unlinkResource(taskId, { type: "session", sessionId });
                           onTasksChanged?.();
                         })
                  }
                  onDeleteSession={onDeleteSession}
                  onDuplicateSession={onDuplicateSession}
                  onMarkUnread={onMarkUnread}
                  hasDraft={hasDraft}
                  onRequestArchived={onRequestArchived}
                  archivedLoaded={archivedLoaded}
                  className=""
                />
              )}
            </Section>

            {/* Work Items */}
            {task.workItems.length > 0 && (
              <Section
                icon={<ClipboardList size={14} />}
                title="Work Items"
                count={task.workItems.length}
              >
                <div className="space-y-1">
                  {(enrichedWIs.length > 0
                    ? enrichedWIs
                    : task.workItems.map((w) => ({
                        id: w.id,
                        provider: w.provider,
                        title: null as string | null,
                        state: null as string | null,
                        type: null as string | null,
                        assignedTo: null as string | null,
                        areaPath: null as string | null,
                        url: "#",
                      }))
                  ).map((wi) => {
                    const typeInfo = WI_TYPE_ICONS[wi.type ?? ""];
                    return (
                      <a
                        key={`${wi.provider}-${wi.id}`}
                        href={wi.url}
                        target="_blank"
                        rel="noopener"
                        className="block px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className={typeInfo?.color ?? "text-text-muted"}>
                            {typeInfo?.icon ?? <ClipboardList size={14} />}
                          </span>
                          <span className="text-xs font-medium text-accent">#{wi.id}</span>
                          {wi.state && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${WI_STATE_STYLES[wi.state] ?? "bg-text-muted/15 text-text-muted"}`}>
                              {wi.state}
                            </span>
                          )}
                        </div>
                        {wi.title && (
                          <div className="text-sm text-text-primary mt-1 ml-6 line-clamp-2">
                            {wi.title}
                          </div>
                        )}
                        {(wi.assignedTo || wi.areaPath) && (
                          <div className="text-[10px] text-text-faint mt-1 ml-6 flex items-center gap-2">
                            {wi.assignedTo && <span>{wi.assignedTo}</span>}
                            {wi.areaPath && <span>{wi.areaPath}</span>}
                          </div>
                        )}
                      </a>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* Pull Requests */}
            {task.pullRequests.length > 0 && (
              <Section
                icon={<GitPullRequest size={14} />}
                title="Pull Requests"
                count={task.pullRequests.length}
              >
                <div className="space-y-1">
                  {(enrichedPRs.length > 0
                    ? enrichedPRs
                    : task.pullRequests.map((pr) => ({
                        repoId: pr.repoId,
                        repoName: pr.repoName ?? null,
                        prId: pr.prId,
                        provider: pr.provider,
                        title: null as string | null,
                        status: null as "active" | "completed" | "abandoned" | null,
                        createdBy: null as string | null,
                        reviewerCount: 0,
                        url: "#",
                      }))
                  ).map((pr) => {
                    const statusInfo = PR_STATUS_STYLES[pr.status ?? ""];
                    return (
                      <a
                        key={`${pr.repoId}-${pr.prId}`}
                        href={pr.url}
                        target="_blank"
                        rel="noopener"
                        className="block px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          {statusInfo ? (
                            <span className={`w-2 h-2 rounded-full shrink-0 ${statusInfo.dot}`} />
                          ) : (
                            <GitPullRequest size={14} className="text-text-muted" />
                          )}
                          <span className="text-xs font-medium text-accent">#{pr.prId}</span>
                          {statusInfo && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              pr.status === "active" ? "bg-success/15 text-success" :
                              pr.status === "completed" ? "bg-accent/15 text-accent" :
                              "bg-text-muted/15 text-text-muted"
                            }`}>
                              {statusInfo.label}
                            </span>
                          )}
                        </div>
                        {pr.title && (
                          <div className="text-sm text-text-primary mt-1 ml-6 line-clamp-2">
                            {pr.title}
                          </div>
                        )}
                        <div className="text-[10px] text-text-faint mt-1 ml-6 flex items-center gap-2">
                          <span>{pr.repoName || pr.repoId}</span>
                          {pr.createdBy && <span>by {pr.createdBy}</span>}
                          {pr.reviewerCount > 0 && <span>{pr.reviewerCount} reviewer{pr.reviewerCount !== 1 ? "s" : ""}</span>}
                        </div>
                      </a>
                    );
                  })}
                </div>
              </Section>
            )}
          </div>

          {/* ── Right Column ─────────────────────────────── */}
          <div className="space-y-6">
            {/* Todos */}
            <Section
              icon={<CheckSquare size={14} />}
              title="Checklist"
              count={todos.length > 0 ? `${doneTodos.length}/${todos.length}` : undefined}
            >
              <div className="space-y-1">
                {openTodos.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    variant="card"
                    todo={todo}
                    onUpdate={(updated) => setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))}
                    onDelete={() => setTodos((prev) => prev.filter((t) => t.id !== todo.id))}
                  />
                ))}
                {doneTodos.length > 0 && (
                  <CollapsibleCompleted count={doneTodos.length}>
                    <div className="pt-1 space-y-1">
                      {doneTodos.map((todo) => (
                        <TodoRow
                          key={todo.id}
                          variant="card"
                          todo={todo}
                          onUpdate={(updated) => setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))}
                          onDelete={() => setTodos((prev) => prev.filter((t) => t.id !== todo.id))}
                        />
                      ))}
                    </div>
                  </CollapsibleCompleted>
                )}
                {/* Add new todo */}
                <form
                  className="flex items-center gap-2 px-3 py-1.5"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const text = newTodoText.trim();
                    if (!text) return;
                    setNewTodoText("");
                    await createTodo(task.id, text);
                    setTodos(await fetchTodos(task.id));
                  }}
                >
                  <Plus size={14} className="text-text-faint shrink-0" />
                  <input
                    type="text"
                    value={newTodoText}
                    onChange={(e) => setNewTodoText(e.target.value)}
                    placeholder="Add a to-do…"
                    className="flex-1 text-sm bg-transparent border-none outline-none text-text-primary placeholder:text-text-faint"
                  />
                </form>
              </div>
            </Section>

            {/* Schedules */}
            <Section
              icon={<Clock size={14} />}
              title="Schedules"
              count={sched.schedules.length}
              action={
                <button
                  onClick={() => sched.openEditor()}
                  className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                >
                  <Plus size={12} /> Add
                </button>
              }
            >
              {sched.schedules.length === 0 ? (
                <EmptyState message="No schedules" sub="Automate recurring work with scheduled sessions" />
              ) : (() => {
                const activeSchedules = sched.schedules.filter((s) => s.enabled);
                const disabledSchedules = sched.schedules.filter((s) => !s.enabled);
                const renderScheduleCard = (schedule: typeof sched.schedules[0]) => (
                  <div
                    key={schedule.id}
                    className="px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors group"
                  >
                    <div className="flex items-center gap-2">
                      <Clock size={14} className={schedule.enabled ? "text-accent" : "text-text-faint"} />
                      <span className={`text-sm font-medium truncate flex-1 ${schedule.enabled ? "text-text-primary" : "text-text-faint line-through"}`}>
                        {schedule.name}
                      </span>
                      <div className="hidden group-hover:flex items-center gap-1">
                        <button
                          onClick={() => sched.trigger(schedule.id)}
                          className="p-1 text-text-muted hover:text-success transition-colors"
                          title="Run now"
                        >
                          <Play size={12} />
                        </button>
                        <button
                          onClick={() => sched.toggle(schedule)}
                          className="p-1 text-text-muted hover:text-warning transition-colors"
                          title={schedule.enabled ? "Pause" : "Resume"}
                        >
                          <Pause size={12} />
                        </button>
                        <button
                          onClick={() => sched.openEditor(schedule)}
                          className="p-1 text-text-muted hover:text-text-primary transition-colors"
                          title="Edit"
                        >
                          <MoreHorizontal size={12} />
                        </button>
                        <button
                          onClick={() => sched.remove(schedule.id)}
                          className="p-1 text-text-muted hover:text-error transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    <div className="text-xs text-text-muted mt-1 ml-6">
                      {schedule.type === "cron" ? schedule.cron : `Once at ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "?"}`}
                    </div>
                    <div className="text-[10px] text-text-faint mt-0.5 ml-6 flex items-center gap-2">
                      {schedule.lastRunAt && <span>Last: {timeAgo(schedule.lastRunAt)}</span>}
                      {schedule.nextRunAt && <span>Next: {timeAgo(schedule.nextRunAt)}</span>}
                      {schedule.runCount > 0 && <span>{schedule.runCount} run{schedule.runCount !== 1 ? "s" : ""}</span>}
                    </div>
                  </div>
                );
                return (
                  <div className="space-y-1">
                    {activeSchedules.map(renderScheduleCard)}
                    <CollapsibleCompleted count={disabledSchedules.length} label="disabled">
                      {disabledSchedules.map(renderScheduleCard)}
                    </CollapsibleCompleted>
                  </div>
                );
              })()}
            </Section>

            {/* Notes */}
            <Section
              icon={<StickyNote size={14} />}
              title="Notes"
              action={
                <button
                  onClick={notes.openToEdit}
                  className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                >
                  <Pencil size={12} /> {task.notes ? "Edit" : "Add"}
                </button>
              }
            >
              {task.notes ? (
                <div
                  onClick={notes.openToView}
                  className="px-3 py-3 cursor-pointer rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
                >
                  <div className="prose prose-invert prose-sm max-w-none text-text-secondary
                    prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1
                    prose-ul:my-1 prose-ol:my-1 prose-li:my-0
                    prose-code:text-accent prose-code:text-xs
                    prose-a:text-accent prose-a:no-underline">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{task.notes}</ReactMarkdown>
                  </div>
                </div>
              ) : (
                <EmptyState message="No notes" sub="Add notes to keep track of context and decisions" />
              )}
            </Section>

            {/* Related Docs */}
            {relatedDocs.length > 0 && (
              <Section
                icon={<BookOpen size={14} />}
                title="Related Docs"
                count={relatedDocs.length}
              >
                <div className="space-y-1">
                  {relatedDocs.map((doc) => (
                    <a
                      key={doc.path}
                      href={`/docs/${doc.path}`}
                      className="block px-3 py-2 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
                    >
                      <div className="text-sm text-text-primary truncate">{doc.title}</div>
                      <div className="text-[10px] text-text-faint mt-0.5 flex items-center gap-2">
                        <span className="font-mono">{doc.path}</span>
                        {doc.tags.length > 0 && (
                          <span>{doc.tags.join(", ")}</span>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>
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

      {/* Schedule Editor Dialog */}
      {sched.scheduleEditorOpen && (
        <ScheduleEditorDialog
          taskId={task.id}
          schedule={sched.editingSchedule}
          onClose={sched.closeEditor}
          onSaved={sched.onSaved}
        />
      )}
    </PullToRefresh>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function Section({
  icon,
  title,
  count,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number | string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider flex items-center gap-1.5">
          {icon}
          {title}
          {count !== undefined && (
            <span className="text-text-faint font-normal">({count})</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </div>
  );
}


