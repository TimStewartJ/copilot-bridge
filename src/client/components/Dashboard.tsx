import { useState, useEffect, useRef, useMemo } from "react";
import {
  patchTodo,
  createGlobalTodo,
  type DashboardData,
  type DashboardActiveTask,
  type DashboardOrphanSession,
  type DashboardTodo,
  type DashboardSchedule,
} from "../api";
import { useDashboardQuery } from "../hooks/queries/useDashboard";
import { useScheduleDetail } from "../hooks/useScheduleDetail";
import { useTriggerScheduleMutation, useToggleScheduleMutation, useDeleteScheduleMutation } from "../hooks/queries/useSchedules";
import { getLastViewedSession } from "../last-viewed";
import { timeAgo } from "../time";
import { GROUP_COLOR_BG, GROUP_COLOR_DOT, GROUP_COLOR_BORDER } from "../group-colors";
import EmptyState from "./shared/EmptyState";
import CollapsibleCompleted from "./shared/CollapsibleCompleted";
import TodoRow from "./TodoRow";
import PullToRefresh from "./PullToRefresh";
import ScheduleDetailSheet from "./ScheduleDetailSheet";
import { Loader2, MessageSquare, Plus, CheckSquare, Check, ChevronDown, ChevronRight, ArrowUpDown, Clock, Play, Pause } from "lucide-react";

type TodoSort = "newest" | "deadline" | "task";

const SORT_LABELS: Record<TodoSort, string> = {
  newest: "Newest",
  deadline: "Deadline",
  task: "By task",
};

const SORT_STORAGE_KEY = "dashboard-todo-sort";

function getSavedSort(): TodoSort {
  try {
    const val = localStorage.getItem(SORT_STORAGE_KEY);
    if (val === "newest" || val === "deadline" || val === "task") return val;
  } catch {}
  return "newest";
}

function deadlineSortKey(deadline: string | undefined): number {
  if (!deadline) return Infinity;
  return new Date(deadline + "T00:00:00").getTime();
}

function sortTodos(todos: DashboardTodo[], sort: TodoSort): DashboardTodo[] {
  const copy = [...todos];
  switch (sort) {
    case "newest":
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    case "deadline":
      return copy.sort((a, b) => deadlineSortKey(a.deadline) - deadlineSortKey(b.deadline) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    case "task":
      return copy.sort((a, b) => {
        // Global todos first, then group by task title
        if (!a.taskId && b.taskId) return -1;
        if (a.taskId && !b.taskId) return 1;
        const titleCmp = (a.taskTitle ?? "").localeCompare(b.taskTitle ?? "");
        if (titleCmp !== 0) return titleCmp;
        return a.order - b.order;
      });
    default:
      return copy;
  }
}

interface DashboardProps {
  onSelectTask: (id: string, opts?: { todoId?: string }) => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onResumeTask: (taskId: string, sessionId?: string) => void;
}

// ── Task grouping for "By task" view ──────────────────────────────

interface TodoGroup {
  key: string;
  taskId: string | null;
  taskTitle: string | null;
  taskGroupColor: string | null;
  todos: DashboardTodo[];
}

const TASK_STATUS_ORDER: Record<string, number> = { active: 0, paused: 1, done: 2, archived: 3 };

function groupTodosByTask(todos: DashboardTodo[]): TodoGroup[] {
  const globalTodos: DashboardTodo[] = [];
  const taskMap = new Map<string, {
    todos: DashboardTodo[];
    taskTitle: string | null;
    taskGroupColor: string | null;
    taskGroupOrder: number | null;
    taskStatusOrder: number;
    taskOrder: number;
  }>();

  for (const todo of todos) {
    if (!todo.taskId) {
      globalTodos.push(todo);
    } else {
      let entry = taskMap.get(todo.taskId);
      if (!entry) {
        entry = {
          todos: [],
          taskTitle: todo.taskTitle,
          taskGroupColor: todo.taskGroupColor,
          taskGroupOrder: todo.taskGroupOrder,
          taskStatusOrder: TASK_STATUS_ORDER[todo.taskStatus ?? "active"] ?? 0,
          taskOrder: todo.taskOrder,
        };
        taskMap.set(todo.taskId, entry);
      }
      entry.todos.push(todo);
    }
  }

  for (const entry of taskMap.values()) {
    entry.todos.sort((a, b) => a.order - b.order);
  }
  globalTodos.sort((a, b) => a.order - b.order);

  // Match TaskRail order: grouped tasks first (by group order), then ungrouped; within each: status → task order
  const taskEntries = [...taskMap.entries()].sort(([, a], [, b]) => {
    const aGrouped = a.taskGroupOrder != null ? 0 : 1;
    const bGrouped = b.taskGroupOrder != null ? 0 : 1;
    if (aGrouped !== bGrouped) return aGrouped - bGrouped;
    if (a.taskGroupOrder != null && b.taskGroupOrder != null && a.taskGroupOrder !== b.taskGroupOrder) {
      return a.taskGroupOrder - b.taskGroupOrder;
    }
    if (a.taskStatusOrder !== b.taskStatusOrder) return a.taskStatusOrder - b.taskStatusOrder;
    return a.taskOrder - b.taskOrder;
  });

  const groups: TodoGroup[] = [];
  if (globalTodos.length > 0) {
    groups.push({ key: "__global__", taskId: null, taskTitle: null, taskGroupColor: null, todos: globalTodos });
  }
  for (const [taskId, entry] of taskEntries) {
    groups.push({ key: taskId, taskId, taskTitle: entry.taskTitle, taskGroupColor: entry.taskGroupColor, todos: entry.todos });
  }
  return groups;
}

const COLLAPSE_STORAGE_KEY = "dashboard-todo-collapsed";

function getCollapsedSet(): Set<string> {
  try {
    const val = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (val) return new Set(JSON.parse(val));
  } catch {}
  return new Set();
}

export default function Dashboard({
  onSelectTask,
  onSelectSession,
  onNewSession,
  onResumeTask,
}: DashboardProps) {
  const { data, isLoading: loading, refetch } = useDashboardQuery();
  const schedDetail = useScheduleDetail();
  const triggerMutation = useTriggerScheduleMutation(undefined);
  const toggleMutation = useToggleScheduleMutation(undefined);
  const deleteMutation = useDeleteScheduleMutation(undefined);
  const [localOpenTodos, setLocalOpenTodos] = useState<DashboardTodo[]>([]);
  const [localCompletedTodos, setLocalCompletedTodos] = useState<DashboardTodo[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [newTodoText, setNewTodoText] = useState("");
  const [todoSort, setTodoSort] = useState<TodoSort>(getSavedSort);
  const lastLocalChange = useRef(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(getCollapsedSet);

  // Sync local todo state from query data, respecting the optimistic update guard
  useEffect(() => {
    if (!data) return;
    const recentLocalChange = Date.now() - lastLocalChange.current < 5000;
    if (!recentLocalChange) {
      setLocalOpenTodos(data.openTodos);
      setLocalCompletedTodos(data.completedTodos);
    }
  }, [data]);

  const sortedOpenTodos = useMemo(() => sortTodos(localOpenTodos, todoSort), [localOpenTodos, todoSort]);
  const todoGroups = useMemo(() => groupTodosByTask(localOpenTodos), [localOpenTodos]);

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const handleSortChange = (sort: TodoSort) => {
    setTodoSort(sort);
    try { localStorage.setItem(SORT_STORAGE_KEY, sort); } catch {}
  };

  const handleAddTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = newTodoText.trim();
    if (!text) return;
    setNewTodoText("");
    lastLocalChange.current = Date.now();
    const tempId = `temp-${Date.now()}`;
    const optimistic: DashboardTodo = {
      id: tempId, taskId: null, text, done: false, order: 0,
      createdAt: new Date().toISOString(),
      taskTitle: null, taskGroupColor: null, taskOrder: 0,
      taskStatus: null, taskGroupId: null, taskGroupOrder: null,
    };
    setLocalOpenTodos((prev) => [optimistic, ...prev]);
    try {
      const todo = await createGlobalTodo(text);
      setLocalOpenTodos((prev) => prev.map((t) =>
        t.id === tempId
          ? { ...todo, taskTitle: null, taskGroupColor: null, taskOrder: 0, taskStatus: null, taskGroupId: null, taskGroupOrder: null }
          : t
      ));
    } catch (err) {
      console.error("Failed to create todo:", err);
      setLocalOpenTodos((prev) => prev.filter((t) => t.id !== tempId));
    }
  };

  const handleRefresh = async () => { await refetch(); };

  if (loading) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <Loader2 className="animate-spin text-text-muted" size={24} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-text-muted text-sm">
        Failed to load dashboard
      </div>
    );
  }

  const { busySessions, unreadSessions, lastActiveTask, orphanSessions, schedules = [] } = data;
  const hasAttention = busySessions.length > 0 || unreadSessions.length > 0;
  const activeSchedules = schedules.filter((s) => s.enabled);
  const pausedSchedules = schedules.filter((s) => !s.enabled);

  return (
    <div className="flex-1 min-h-0 relative">
    <PullToRefresh onRefresh={handleRefresh} className="absolute inset-0">
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

        {/* ── Dashboard Content (2-col) ──────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: To-Dos (wider) */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
                <CheckSquare size={14} />
                Open To-Dos
                {localOpenTodos.length > 0 && (
                  <span className="text-text-faint font-normal">({localOpenTodos.filter((t) => !exitingIds.has(t.id)).length})</span>
                )}
              </h2>
              {localOpenTodos.length > 1 && (
                <div className="flex items-center gap-1">
                  <ArrowUpDown size={11} className="text-text-faint" />
                  {(Object.keys(SORT_LABELS) as TodoSort[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => handleSortChange(s)}
                      className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${
                        todoSort === s
                          ? "bg-accent/15 text-accent font-medium"
                          : "text-text-faint hover:text-text-secondary"
                      }`}
                    >
                      {SORT_LABELS[s]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Add todo input */}
            <form onSubmit={handleAddTodo}>
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-surface border border-border focus-within:border-accent transition-colors">
                <Plus size={14} className="text-text-faint shrink-0" />
                <input
                  type="text"
                  value={newTodoText}
                  onChange={(e) => setNewTodoText(e.target.value)}
                  placeholder="Add a to-do…"
                  className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-faint outline-none"
                />
              </div>
            </form>

            {localOpenTodos.length === 0 && localCompletedTodos.length === 0 ? (
              <EmptyState
                message="No to-dos yet"
                sub="Add one above or from within a task"
              />
            ) : (
              <>
                {localOpenTodos.length > 0 && todoSort === "task" ? (
                  <div className="space-y-2">
                    {todoGroups.map((group) => {
                      const isCollapsed = collapsedGroups.has(group.key);
                      const visibleCount = group.todos.filter((t) => !exitingIds.has(t.id)).length;
                      return (
                        <div key={group.key} className="bg-bg-surface border border-border rounded-lg overflow-hidden">
                          <button
                            onClick={() => toggleGroupCollapse(group.key)}
                            className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-bg-hover transition-colors"
                          >
                            {isCollapsed
                              ? <ChevronRight size={14} className="text-text-faint shrink-0" />
                              : <ChevronDown size={14} className="text-text-faint shrink-0" />
                            }
                            {group.taskGroupColor && (
                              <span className={`w-2 h-2 rounded-full shrink-0 ${GROUP_COLOR_DOT[group.taskGroupColor] ?? ""}`} />
                            )}
                            <span className="font-medium text-text-secondary truncate">
                              {group.taskTitle ?? "Global To-Dos"}
                            </span>
                            <span className="text-text-faint text-xs ml-auto shrink-0">{visibleCount}</span>
                          </button>
                          {!isCollapsed && (
                            <div className="divide-y divide-border border-t border-border">
                              {group.todos.map((todo) => (
                                <div
                                  key={todo.id}
                                  className={exitingIds.has(todo.id) ? "animate-todo-check" : ""}
                                  onAnimationEnd={() => {
                                    if (exitingIds.has(todo.id)) {
                                      setExitingIds((prev) => { const n = new Set(prev); n.delete(todo.id); return n; });
                                      setLocalOpenTodos((prev) => prev.filter((t) => t.id !== todo.id));
                                      setLocalCompletedTodos((prev) => [{ ...todo, done: true }, ...prev]);
                                    }
                                  }}
                                >
                                  <TodoRow
                                    variant="dashboard"
                                    todo={todo}
                                    hideTaskPill
                                    onSelectTask={todo.taskId ? () => onSelectTask(todo.taskId!, { todoId: todo.id }) : undefined}
                                    onToggle={async () => {
                                      lastLocalChange.current = Date.now();
                                      setExitingIds((prev) => new Set(prev).add(todo.id));
                                      await patchTodo(todo.id, { done: true });
                                    }}
                                    onDeadlineChange={(deadline) => {
                                      lastLocalChange.current = Date.now();
                                      setLocalOpenTodos((prev) => prev.map((t) =>
                                        t.id === todo.id ? { ...t, deadline: deadline ?? undefined } : t
                                      ));
                                    }}
                                    onUpdate={(updated) => {
                                      lastLocalChange.current = Date.now();
                                      setLocalOpenTodos((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                                    }}
                                    onDelete={() => {
                                      lastLocalChange.current = Date.now();
                                      setLocalOpenTodos((prev) => prev.filter((t) => t.id !== todo.id));
                                    }}
                                    canDelete={!todo.taskId}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : localOpenTodos.length > 0 ? (
                  <div className="bg-bg-surface border border-border rounded-lg divide-y divide-border">
                    {sortedOpenTodos.map((todo) => (
                      <div
                        key={todo.id}
                        className={exitingIds.has(todo.id) ? "animate-todo-check" : ""}
                        onAnimationEnd={() => {
                          if (exitingIds.has(todo.id)) {
                            setExitingIds((prev) => { const n = new Set(prev); n.delete(todo.id); return n; });
                            setLocalOpenTodos((prev) => prev.filter((t) => t.id !== todo.id));
                            setLocalCompletedTodos((prev) => [{ ...todo, done: true }, ...prev]);
                          }
                        }}
                      >
                        <TodoRow
                          variant="dashboard"
                          todo={todo}
                          onSelectTask={todo.taskId ? () => onSelectTask(todo.taskId!, { todoId: todo.id }) : undefined}
                          onToggle={async () => {
                            lastLocalChange.current = Date.now();
                            setExitingIds((prev) => new Set(prev).add(todo.id));
                            await patchTodo(todo.id, { done: true });
                          }}
                          onDeadlineChange={(deadline) => {
                            lastLocalChange.current = Date.now();
                            setLocalOpenTodos((prev) => prev.map((t) =>
                              t.id === todo.id ? { ...t, deadline: deadline ?? undefined } : t
                            ));
                          }}
                          onUpdate={(updated) => {
                            lastLocalChange.current = Date.now();
                            setLocalOpenTodos((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                          }}
                          onDelete={() => {
                            lastLocalChange.current = Date.now();
                            setLocalOpenTodos((prev) => prev.filter((t) => t.id !== todo.id));
                          }}
                          canDelete={!todo.taskId}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}

                {localOpenTodos.length === 0 && localCompletedTodos.length > 0 && (
                  <div className="text-center py-6 px-4 rounded-md bg-bg-surface border border-border">
                    <div className="text-sm text-success">✓ All done!</div>
                  </div>
                )}

                {localCompletedTodos.length > 0 && (
                  <>
                    <button
                      onClick={() => setShowCompleted((v) => !v)}
                      className="text-sm font-medium text-text-muted flex items-center gap-1.5 hover:text-text-secondary transition-colors"
                    >
                      {showCompleted ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <Check size={14} />
                      Completed
                      <span className="text-text-faint font-normal">({localCompletedTodos.length})</span>
                    </button>
                    {showCompleted && (
                      <div className="bg-bg-surface border border-border rounded-lg divide-y divide-border">
                        {localCompletedTodos.map((todo) => (
                          <TodoRow
                            key={todo.id}
                            variant="dashboard"
                            todo={todo}
                            onSelectTask={todo.taskId ? () => onSelectTask(todo.taskId!, { todoId: todo.id }) : undefined}
                            onToggle={async () => {
                              lastLocalChange.current = Date.now();
                              setLocalCompletedTodos((prev) => prev.filter((t) => t.id !== todo.id));
                              setLocalOpenTodos((prev) => [...prev, { ...todo, done: false }]);
                              await patchTodo(todo.id, { done: false });
                            }}
                            onUpdate={(updated) => {
                              lastLocalChange.current = Date.now();
                              setLocalCompletedTodos((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                            }}
                            onDelete={() => {
                              lastLocalChange.current = Date.now();
                              setLocalCompletedTodos((prev) => prev.filter((t) => t.id !== todo.id));
                            }}
                            canDelete={!todo.taskId}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {/* Right: Orphan Sessions + Schedules */}
          <div className="space-y-6">
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

            {/* Schedules */}
            {schedules.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
                    <Clock size={14} />
                    Schedules
                    <span className="text-text-faint font-normal text-xs">
                      ({activeSchedules.length} active{pausedSchedules.length > 0 ? ` · ${pausedSchedules.length} paused` : ""})
                    </span>
                  </h2>
                </div>

                <div className="space-y-1.5">
                  {activeSchedules.map((schedule) => (
                    <DashboardScheduleRow
                      key={schedule.id}
                      schedule={schedule}
                      onOpen={() => schedDetail.openSheet(schedule)}
                      onSelectTask={() => onSelectTask(schedule.taskId)}
                      onTrigger={() => triggerMutation.mutate(schedule.id)}
                      onToggle={() => toggleMutation.mutate(schedule)}
                    />
                  ))}
                  <CollapsibleCompleted count={pausedSchedules.length} label="paused">
                    {pausedSchedules.map((schedule) => (
                      <DashboardScheduleRow
                        key={schedule.id}
                        schedule={schedule}
                        onOpen={() => schedDetail.openSheet(schedule)}
                        onSelectTask={() => onSelectTask(schedule.taskId)}
                        onTrigger={() => triggerMutation.mutate(schedule.id)}
                        onToggle={() => toggleMutation.mutate(schedule)}
                      />
                    ))}
                  </CollapsibleCompleted>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Schedule Detail Sheet (unified view/edit) */}
      {schedDetail.isOpen && (
        <ScheduleDetailSheet
          schedule={schedDetail.schedule}
          taskId={schedDetail.schedule?.taskId ?? ""}
          taskTitle={(schedDetail.schedule as DashboardSchedule | null)?.taskTitle}
          mode={schedDetail.mode}
          onClose={schedDetail.close}
          onSwitchToEdit={schedDetail.switchToEdit}
          onSwitchToView={schedDetail.switchToView}
          onTrigger={(id) => triggerMutation.mutate(id)}
          onToggle={(s) => toggleMutation.mutate(s)}
          onDelete={(id) => { deleteMutation.mutate(id); schedDetail.close(); }}
          onSaved={() => { schedDetail.close(); refetch(); }}
          onSelectSession={onSelectSession}
          onSelectTask={onSelectTask}
        />
      )}
    </PullToRefresh>
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
  const lastViewed = getLastViewedSession(t.id);
  const lastSessionId = t.sessionIds.length > 0
    ? (lastViewed && t.sessionIds.includes(lastViewed) ? lastViewed : t.sessionIds[t.sessionIds.length - 1])
    : undefined;

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
          {activeTask.todoSummary.total > 0 && (
            <span>{activeTask.todoSummary.done}/{activeTask.todoSummary.total} todos</span>
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

function DashboardScheduleRow({
  schedule,
  onOpen,
  onSelectTask,
  onTrigger,
  onToggle,
}: {
  schedule: DashboardSchedule;
  onOpen: () => void;
  onSelectTask: () => void;
  onTrigger: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="px-3 py-2.5 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors group">
      <div className="flex items-center gap-2">
        <Clock size={14} className={schedule.enabled ? "text-accent" : "text-text-faint"} />
        <button
          onClick={onOpen}
          className={`text-sm font-medium truncate flex-1 text-left hover:text-accent transition-colors ${
            schedule.enabled ? "text-text-primary" : "text-text-faint line-through"
          }`}
        >
          {schedule.name}
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={onTrigger}
            className="p-1 text-text-muted hover:text-success transition-colors"
            title="Run now"
          >
            <Play size={12} />
          </button>
          <button
            onClick={onToggle}
            className="p-1 text-text-muted hover:text-warning transition-colors"
            title={schedule.enabled ? "Pause" : "Resume"}
          >
            <Pause size={12} />
          </button>
        </div>
      </div>
      <div className="text-xs text-text-muted mt-1 ml-6 flex items-center gap-2 flex-wrap">
        {schedule.taskTitle && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelectTask(); }}
            className="text-accent hover:text-accent-hover transition-colors truncate max-w-[150px]"
          >
            {schedule.taskTitle}
          </button>
        )}
        <span className="text-text-faint">
          {schedule.type === "cron" ? schedule.cron : `Once at ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "?"}`}
        </span>
      </div>
      <div className="text-[10px] text-text-faint mt-0.5 ml-6 flex items-center gap-2">
        {schedule.lastRunAt && <span>Last: {timeAgo(schedule.lastRunAt)}</span>}
        {schedule.nextRunAt && <span>Next: {timeAgo(schedule.nextRunAt)}</span>}
        {schedule.runCount > 0 && <span>{schedule.runCount} run{schedule.runCount !== 1 ? "s" : ""}</span>}
      </div>
    </div>
  );
}
