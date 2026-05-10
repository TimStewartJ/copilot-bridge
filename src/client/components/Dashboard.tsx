import { useState, useEffect, useRef, useMemo } from "react";
import {
  getSessionActivityTime,
  getSessionRunState,
  patchChecklistItem,
  createGlobalChecklistItem,
  type DashboardActiveTask,
  type DashboardOrphanSession,
  type DashboardChecklistItem,
  type DashboardSchedule,
  type DashboardTaskMomentum,
  type Session,
} from "../api";
import { useDashboardQuery } from "../hooks/queries/useDashboard";
import { useScheduleDetail } from "../hooks/useScheduleDetail";
import { useTriggerScheduleMutation, useToggleScheduleMutation, useDeleteScheduleMutation } from "../hooks/queries/useSchedules";
import { getTaskActiveChatSessionId, type SessionNavigationTarget } from "../lib/session-path";
import { getLastViewedSession } from "../last-viewed";
import { getTaskCompletionState } from "../task-completion-helpers";
import { timeAgo } from "../time";
import { GROUP_COLOR_BG, GROUP_COLOR_DOT, GROUP_COLOR_BORDER } from "../group-colors";
import EmptyState from "./shared/EmptyState";
import CollapsibleCompleted from "./shared/CollapsibleCompleted";
import ChecklistItemRow from "./ChecklistItemRow";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import ScheduleDetailSheet from "./ScheduleDetailSheet";
import { MessageSquare, Plus, CheckSquare, Check, ChevronDown, ChevronRight, ArrowUpDown, Clock, Bell, HelpCircle, Archive, AlertTriangle, Hourglass } from "lucide-react";
import { ScheduleRow } from "./task-sections";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { UI } from "./shared/design-system";

type ChecklistSort = "deadline" | "task";

const SORT_LABELS: Record<ChecklistSort, string> = {
  deadline: "Deadline",
  task: "By task",
};

const SORT_STORAGE_KEY = "dashboard-checklist-sort";

function DashboardSkeleton() {
  return (
    <LoadingSkeletonRegion
      isLoading
      label="Loading dashboard"
      className="flex-1 min-h-0 overflow-y-auto"
    >
      <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 space-y-6">
        <SkeletonCard className="flex items-center gap-4">
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton height={10} width="28%" shape="pill" />
            <Skeleton height={18} width="54%" shape="pill" />
            <div className="flex gap-3">
              <Skeleton height={10} width={80} shape="pill" />
              <Skeleton height={10} width={96} shape="pill" />
              <Skeleton height={10} width={64} shape="pill" />
            </div>
          </div>
          <div className="hidden shrink-0 gap-2 sm:flex">
            <Skeleton height={28} width={94} shape="rounded" />
            <Skeleton height={28} width={82} shape="rounded" />
          </div>
        </SkeletonCard>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton height={12} width={132} shape="pill" />
              <Skeleton height={12} width={88} shape="pill" />
            </div>
            <Skeleton height={38} className="w-full" />
            <SkeletonCard className="divide-y divide-border p-0">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton shape="circle" width={18} height={18} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <SkeletonText
                      lines={2}
                      widths={index % 2 === 0 ? ["76%", "42%"] : ["62%", "34%"]}
                    />
                  </div>
                  <Skeleton height={18} width={72} shape="pill" className="hidden sm:block" />
                </div>
              ))}
            </SkeletonCard>
          </div>

          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Skeleton height={12} width={104} shape="pill" />
                <Skeleton height={12} width={68} shape="pill" />
              </div>
              <div className="space-y-1.5">
                {Array.from({ length: 3 }, (_, index) => (
                  <SkeletonCard key={index} className="px-3 py-2.5">
                    <SkeletonText
                      lines={2}
                      widths={index === 0 ? ["70%", "48%"] : ["56%", "36%"]}
                    />
                  </SkeletonCard>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <Skeleton height={12} width={120} shape="pill" />
              <div className="space-y-1.5">
                {Array.from({ length: 2 }, (_, index) => (
                  <SkeletonCard key={index} className="px-3 py-2.5">
                    <SkeletonText
                      lines={2}
                      widths={index === 0 ? ["64%", "48%"] : ["72%", "38%"]}
                    />
                  </SkeletonCard>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

function getSavedSort(): ChecklistSort {
  try {
    const val = localStorage.getItem(SORT_STORAGE_KEY);
    if (val === "deadline" || val === "task") return val;
  } catch {}
  return "deadline";
}

function deadlineSortKey(deadline: string | undefined): number {
  if (!deadline) return Infinity;
  return new Date(deadline + "T00:00:00").getTime();
}

function sortChecklistItems(
  checklistItems: DashboardChecklistItem[],
  sort: ChecklistSort,
): DashboardChecklistItem[] {
  const copy = [...checklistItems];
  switch (sort) {
    case "deadline":
      return copy.sort((a, b) => deadlineSortKey(a.deadline) - deadlineSortKey(b.deadline) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    case "task":
      return copy.sort((a, b) => {
        // Global checklist items first, then group by task title
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
  onSelectSession: (target: SessionNavigationTarget) => void;
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onNewSession: () => void;
  onResumeTask: (taskId: string, sessionId?: string) => void;
  sessions: Session[];
  scrollRestoration?: PullToRefreshScrollRestoration;
}

// ── Task grouping for "By task" view ──────────────────────────────

interface ChecklistGroup {
  key: string;
  taskId: string | null;
  taskTitle: string | null;
  taskGroupColor: string | null;
  checklistItems: DashboardChecklistItem[];
}

const TASK_STATUS_ORDER: Record<string, number> = { active: 0, done: 1, archived: 2 };

function groupChecklistItemsByTask(checklistItems: DashboardChecklistItem[]): ChecklistGroup[] {
  const globalChecklistItems: DashboardChecklistItem[] = [];
  const taskMap = new Map<string, {
    checklistItems: DashboardChecklistItem[];
    taskTitle: string | null;
    taskGroupColor: string | null;
    taskGroupOrder: number | null;
    taskStatusOrder: number;
    taskOrder: number;
  }>();

  for (const checklistItem of checklistItems) {
    if (!checklistItem.taskId) {
      globalChecklistItems.push(checklistItem);
    } else {
      let entry = taskMap.get(checklistItem.taskId);
      if (!entry) {
        entry = {
          checklistItems: [],
          taskTitle: checklistItem.taskTitle,
          taskGroupColor: checklistItem.taskGroupColor,
          taskGroupOrder: checklistItem.taskGroupOrder,
          taskStatusOrder: TASK_STATUS_ORDER[checklistItem.taskStatus ?? "active"] ?? 0,
          taskOrder: checklistItem.taskOrder,
        };
        taskMap.set(checklistItem.taskId, entry);
      }
      entry.checklistItems.push(checklistItem);
    }
  }

  for (const entry of taskMap.values()) {
    entry.checklistItems.sort((a, b) => a.order - b.order);
  }
  globalChecklistItems.sort((a, b) => a.order - b.order);

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

  const groups: ChecklistGroup[] = [];
  if (globalChecklistItems.length > 0) {
    groups.push({
      key: "__global__",
      taskId: null,
      taskTitle: null,
      taskGroupColor: null,
      checklistItems: globalChecklistItems,
    });
  }
  for (const [taskId, entry] of taskEntries) {
    groups.push({
      key: taskId,
      taskId,
      taskTitle: entry.taskTitle,
      taskGroupColor: entry.taskGroupColor,
      checklistItems: entry.checklistItems,
    });
  }
  return groups;
}

const COLLAPSE_STORAGE_KEY = "dashboard-checklist-collapsed";

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
  sessions,
  scrollRestoration,
}: DashboardProps) {
  const { data, isLoading: loading, refetch } = useDashboardQuery();
  const schedDetail = useScheduleDetail();
  const triggerMutation = useTriggerScheduleMutation(undefined);
  const toggleMutation = useToggleScheduleMutation(undefined);
  const deleteMutation = useDeleteScheduleMutation(undefined);
  const [localOpenChecklistItems, setLocalOpenChecklistItems] = useState<DashboardChecklistItem[]>([]);
  const [localCompletedChecklistItems, setLocalCompletedChecklistItems] = useState<DashboardChecklistItem[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [newChecklistItemText, setNewChecklistItemText] = useState("");
  const [checklistSort, setChecklistSort] = useState<ChecklistSort>(getSavedSort);
  const lastLocalChange = useRef(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(getCollapsedSet);

  // Sync local checklist state from query data, respecting the optimistic update guard
  useEffect(() => {
    if (!data) return;
    const recentLocalChange = Date.now() - lastLocalChange.current < 5000;
    if (!recentLocalChange) {
      setLocalOpenChecklistItems(data.openChecklistItems);
      setLocalCompletedChecklistItems(data.completedChecklistItems);
    }
  }, [data]);

  const sortedOpenChecklistItems = useMemo(
    () => sortChecklistItems(localOpenChecklistItems, checklistSort),
    [localOpenChecklistItems, checklistSort],
  );
  const checklistGroups = useMemo(
    () => groupChecklistItemsByTask(localOpenChecklistItems),
    [localOpenChecklistItems],
  );

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const handleSortChange = (sort: ChecklistSort) => {
    setChecklistSort(sort);
    try { localStorage.setItem(SORT_STORAGE_KEY, sort); } catch {}
  };

  const handleAddChecklistItem = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = newChecklistItemText.trim();
    if (!text) return;
    setNewChecklistItemText("");
    lastLocalChange.current = Date.now();
    const tempId = `temp-${Date.now()}`;
    const optimistic: DashboardChecklistItem = {
      id: tempId, taskId: null, text, done: false, order: 0,
      createdAt: new Date().toISOString(),
      taskTitle: null, taskGroupColor: null, taskOrder: 0,
      taskStatus: null, taskGroupId: null, taskGroupOrder: null,
    };
    setLocalOpenChecklistItems((prev) => [optimistic, ...prev]);
    try {
      const checklistItem = await createGlobalChecklistItem(text);
      setLocalOpenChecklistItems((prev) => prev.map((t) =>
        t.id === tempId
          ? { ...checklistItem, taskTitle: null, taskGroupColor: null, taskOrder: 0, taskStatus: null, taskGroupId: null, taskGroupOrder: null }
          : t
      ));
    } catch (err) {
      console.error("Failed to create checklist item:", err);
      setLocalOpenChecklistItems((prev) => prev.filter((t) => t.id !== tempId));
    }
  };

  const handleRefresh = async () => { await refetch(); };

  if (loading && !data) return <DashboardSkeleton />;

  if (!data) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-text-muted text-sm">
        Failed to load dashboard
      </div>
    );
  }

  const { busySessions, unreadSessions, lastActiveTask, orphanSessions, schedules = [], taskMomentum } = data;
  const workingSessions = busySessions.filter((s) => s.runState !== "stalled");
  const stalledSessions = busySessions.filter((s) => s.runState === "stalled");
  const hasAttention = busySessions.length > 0 || unreadSessions.length > 0;
  const activeSchedules = schedules.filter((s) => s.enabled);
  const pausedSchedules = schedules.filter((s) => !s.enabled);
  const selectSession = (session: SessionNavigationTarget) => {
    onSelectSession({ sessionId: session.sessionId, taskId: session.taskId ?? null });
  };

  return (
    <div className="flex-1 min-h-0 relative">
    <PullToRefresh
      onRefresh={handleRefresh}
      className="absolute inset-0"
      scrollRestoration={scrollRestoration}
    >
      {/* ── Attention Bar ─────────────────────────────────── */}
      {hasAttention && (
        <div className="border-b border-border/80 bg-bg-secondary/95">
          <div className="max-w-5xl mx-auto px-4 md:px-8 py-3 space-y-2">
            {workingSessions.length > 0 && (
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  <span className="flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-info opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-info" />
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-info">
                    {workingSessions.length} session{workingSessions.length > 1 ? "s" : ""} working
                  </span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {workingSessions.map((s) => (
                      <button
                        key={s.sessionId}
                        onClick={() => selectSession(s)}
                        className="max-w-[200px] truncate rounded border border-info-border bg-info-surface px-2 py-1 text-xs text-info transition-colors hover:border-info"
                      >
                        {s.intentText || s.title}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {stalledSessions.length > 0 && (
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  <span className="flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-warning opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-warning" />
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-warning">
                    {stalledSessions.length} session{stalledSessions.length > 1 ? "s" : ""} stalled
                  </span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {stalledSessions.map((s) => (
                      <button
                        key={s.sessionId}
                        onClick={() => selectSession(s)}
                        className="text-xs px-2 py-1 rounded bg-warning/10 text-warning hover:bg-warning/20 transition-colors truncate max-w-[200px]"
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
                        onClick={() => selectSession(s)}
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
            sessions={sessions}
            onResume={onResumeTask}
            onSelect={onSelectTask}
          />
        )}

        {/* ── Momentum Queues ────────────────────────────── */}
        {taskMomentum && (
          <MomentumQueues
            momentum={taskMomentum}
            onSelectTask={onSelectTask}
          />
        )}

        {/* ── Dashboard Content (2-col) ──────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Checklist (wider) */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className={UI.text.sectionTitle}>
                <CheckSquare size={14} />
                Open Checklist
                {localOpenChecklistItems.length > 0 && (
                  <span className="text-text-faint font-normal">({localOpenChecklistItems.filter((t) => !exitingIds.has(t.id)).length})</span>
                )}
              </h2>
              {localOpenChecklistItems.length > 1 && (
                <div className="flex items-center gap-1">
                  <ArrowUpDown size={11} className="text-text-faint" />
                  {(Object.keys(SORT_LABELS) as ChecklistSort[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => handleSortChange(s)}
                      className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${
                        checklistSort === s
                          ? `${UI.chip.selected} font-medium`
                          : "text-text-faint hover:text-text-secondary"
                      }`}
                    >
                      {SORT_LABELS[s]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Add checklist item input */}
            <form onSubmit={handleAddChecklistItem}>
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-surface border border-border focus-within:border-accent transition-colors">
                <Plus size={14} className="text-text-faint shrink-0" />
                <input
                  type="text"
                  value={newChecklistItemText}
                  onChange={(e) => setNewChecklistItemText(e.target.value)}
                  placeholder="Add a checklist item..."
                  className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-faint outline-none"
                />
              </div>
            </form>

            {localOpenChecklistItems.length === 0 && localCompletedChecklistItems.length === 0 ? (
              <EmptyState
                message="No checklist items yet"
                sub="Add one above or from within a task"
              />
            ) : (
              <>
                {localOpenChecklistItems.length > 0 && checklistSort === "task" ? (
                  <div className="space-y-2">
                    {checklistGroups.map((group) => {
                      const isCollapsed = collapsedGroups.has(group.key);
                      const visibleCount = group.checklistItems.filter((t) => !exitingIds.has(t.id)).length;
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
                              {group.taskTitle ?? "Global Checklist"}
                            </span>
                            <span className="text-text-faint text-xs ml-auto shrink-0">{visibleCount}</span>
                          </button>
                          {!isCollapsed && (
                            <div className="divide-y divide-border border-t border-border">
                              {group.checklistItems.map((checklistItem) => (
                                <div
                                  key={checklistItem.id}
                                  className={exitingIds.has(checklistItem.id) ? "animate-checklist-check" : ""}
                                  onAnimationEnd={() => {
                                    if (exitingIds.has(checklistItem.id)) {
                                      setExitingIds((prev) => { const n = new Set(prev); n.delete(checklistItem.id); return n; });
                                      setLocalOpenChecklistItems((prev) => prev.filter((t) => t.id !== checklistItem.id));
                                      setLocalCompletedChecklistItems((prev) => [{ ...checklistItem, done: true }, ...prev]);
                                    }
                                  }}
                                >
                                  <ChecklistItemRow
                                    variant="dashboard"
                                    checklistItem={checklistItem}
                                    hideTaskPill
                                    onSelectTask={checklistItem.taskId ? () => onSelectTask(checklistItem.taskId!, { checklistItemId: checklistItem.id }) : undefined}
                                    onToggle={async () => {
                                      lastLocalChange.current = Date.now();
                                      setExitingIds((prev) => new Set(prev).add(checklistItem.id));
                                      await patchChecklistItem(checklistItem.id, { done: true });
                                    }}
                                    onDeadlineChange={(deadline) => {
                                      lastLocalChange.current = Date.now();
                                      setLocalOpenChecklistItems((prev) => prev.map((t) =>
                                        t.id === checklistItem.id ? { ...t, deadline: deadline ?? undefined } : t
                                      ));
                                    }}
                                    onUpdate={(updated) => {
                                      lastLocalChange.current = Date.now();
                                      setLocalOpenChecklistItems((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                                    }}
                                    onDelete={() => {
                                      lastLocalChange.current = Date.now();
                                      setLocalOpenChecklistItems((prev) => prev.filter((t) => t.id !== checklistItem.id));
                                    }}
                                    canDelete={!checklistItem.taskId}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : localOpenChecklistItems.length > 0 ? (
                  <div className="bg-bg-surface border border-border rounded-lg divide-y divide-border">
                    {sortedOpenChecklistItems.map((checklistItem) => (
                      <div
                        key={checklistItem.id}
                        className={exitingIds.has(checklistItem.id) ? "animate-checklist-check" : ""}
                        onAnimationEnd={() => {
                          if (exitingIds.has(checklistItem.id)) {
                            setExitingIds((prev) => { const n = new Set(prev); n.delete(checklistItem.id); return n; });
                            setLocalOpenChecklistItems((prev) => prev.filter((t) => t.id !== checklistItem.id));
                            setLocalCompletedChecklistItems((prev) => [{ ...checklistItem, done: true }, ...prev]);
                          }
                        }}
                      >
                        <ChecklistItemRow
                          variant="dashboard"
                          checklistItem={checklistItem}
                          onSelectTask={checklistItem.taskId ? () => onSelectTask(checklistItem.taskId!, { checklistItemId: checklistItem.id }) : undefined}
                          onToggle={async () => {
                            lastLocalChange.current = Date.now();
                            setExitingIds((prev) => new Set(prev).add(checklistItem.id));
                            await patchChecklistItem(checklistItem.id, { done: true });
                          }}
                          onDeadlineChange={(deadline) => {
                            lastLocalChange.current = Date.now();
                            setLocalOpenChecklistItems((prev) => prev.map((t) =>
                              t.id === checklistItem.id ? { ...t, deadline: deadline ?? undefined } : t
                            ));
                          }}
                          onUpdate={(updated) => {
                            lastLocalChange.current = Date.now();
                            setLocalOpenChecklistItems((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                          }}
                          onDelete={() => {
                            lastLocalChange.current = Date.now();
                            setLocalOpenChecklistItems((prev) => prev.filter((t) => t.id !== checklistItem.id));
                          }}
                          canDelete={!checklistItem.taskId}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}

                {localOpenChecklistItems.length === 0 && localCompletedChecklistItems.length > 0 && (
                  <div className="text-center py-6 px-4 rounded-md bg-bg-surface border border-border">
                    <div className="text-sm text-success">✓ All done!</div>
                  </div>
                )}

                {localCompletedChecklistItems.length > 0 && (
                  <>
                    <button
                      onClick={() => setShowCompleted((v) => !v)}
                      className={UI.text.sectionTitle}
                    >
                      {showCompleted ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <Check size={14} />
                      Completed
                      <span className="text-text-faint font-normal">({localCompletedChecklistItems.length})</span>
                    </button>
                    {showCompleted && (
                      <div className="bg-bg-surface border border-border rounded-lg divide-y divide-border">
                        {localCompletedChecklistItems.map((checklistItem) => (
                          <ChecklistItemRow
                            key={checklistItem.id}
                            variant="dashboard"
                            checklistItem={checklistItem}
                            onSelectTask={checklistItem.taskId ? () => onSelectTask(checklistItem.taskId!, { checklistItemId: checklistItem.id }) : undefined}
                            onToggle={async () => {
                              lastLocalChange.current = Date.now();
                              setLocalCompletedChecklistItems((prev) => prev.filter((t) => t.id !== checklistItem.id));
                              setLocalOpenChecklistItems((prev) => [...prev, { ...checklistItem, done: false }]);
                              await patchChecklistItem(checklistItem.id, { done: false });
                            }}
                            onUpdate={(updated) => {
                              lastLocalChange.current = Date.now();
                              setLocalCompletedChecklistItems((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                            }}
                            onDelete={() => {
                              lastLocalChange.current = Date.now();
                              setLocalCompletedChecklistItems((prev) => prev.filter((t) => t.id !== checklistItem.id));
                            }}
                            canDelete={!checklistItem.taskId}
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
                <h2 className={UI.text.sectionTitle}>
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
                      onSelect={() => selectSession(s)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Schedules */}
            {schedules.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className={UI.text.sectionTitle}>
                    <Clock size={14} />
                    Schedules
                    <span className="text-text-faint font-normal text-xs">
                      ({activeSchedules.length} active{pausedSchedules.length > 0 ? ` · ${pausedSchedules.length} paused` : ""})
                    </span>
                  </h2>
                </div>

                <div className="space-y-1.5">
                  {activeSchedules.map((schedule) => (
                    <ScheduleRow
                      key={schedule.id}
                      schedule={schedule}
                      variant="card"
                      onOpen={(s) => schedDetail.openSheet(s)}
                      onSelectTask={(taskId) => onSelectTask(taskId)}
                      onTrigger={(id) => triggerMutation.mutate(id)}
                      onToggle={(s) => toggleMutation.mutate(s)}
                    />
                  ))}
                  <CollapsibleCompleted count={pausedSchedules.length} label="paused">
                    {pausedSchedules.map((schedule) => (
                      <ScheduleRow
                        key={schedule.id}
                        schedule={schedule}
                        variant="card"
                        onOpen={(s) => schedDetail.openSheet(s)}
                        onSelectTask={(taskId) => onSelectTask(taskId)}
                        onTrigger={(id) => triggerMutation.mutate(id)}
                        onToggle={(s) => toggleMutation.mutate(s)}
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
          onSelectSession={(sessionId) => selectSession({ sessionId, taskId: schedDetail.schedule?.taskId ?? null })}
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
  sessions,
  onResume,
  onSelect,
}: {
  activeTask: DashboardActiveTask;
  sessions: Session[];
  onResume: (taskId: string, sessionId?: string) => void;
  onSelect: (taskId: string) => void;
}) {
  const t = activeTask.task;
  const lastSessionId = getTaskActiveChatSessionId({
    task: t,
    sessions,
    lastViewedSessionId: getLastViewedSession(t.id),
  });

  return (
    <div className={`${UI.surface.card} flex items-center gap-4 p-4`}>
      <div className="flex-1 min-w-0">
        <div className={UI.text.eyebrow}>Pick up where you left off</div>
        <button
          onClick={() => onSelect(t.id)}
          className="mt-1 block truncate text-base font-semibold text-text-primary transition-colors hover:text-accent"
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
          {activeTask.checklistSummary.total > 0 && (
            <span>{activeTask.checklistSummary.done}/{activeTask.checklistSummary.total} checklist items</span>
          )}
          <span>{timeAgo(activeTask.lastActivity)}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {lastSessionId && (
          <button
            onClick={() => onResume(t.id, lastSessionId)}
            className={`${UI.button.primary} flex items-center gap-1.5 py-1.5 text-xs`}
          >
            <MessageSquare size={12} />
            Resume Chat
          </button>
        )}
        <button
          onClick={() => onResume(t.id)}
          className={`${UI.button.secondary} flex items-center gap-1.5`}
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
      className="w-full rounded-lg bg-bg-surface px-3 py-2.5 text-left transition-colors hover:bg-bg-hover"
    >
      <div className="flex items-center gap-2">
        {(session.busy || session.unread) && (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              getSessionRunState(session) === "stalled"
                ? "bg-warning animate-pulse"
                : session.busy
                  ? "bg-info animate-pulse"
                  : "bg-success"
            }`}
          />
        )}
        <span className={`text-sm truncate ${session.unread ? "font-semibold" : ""}`}>
          {session.title || "Untitled"}
        </span>
      </div>
      <div className="text-xs text-text-muted mt-0.5 ml-3.5">
        {timeAgo(getSessionActivityTime(session))}
        {session.branch && (
          <span className="text-text-faint"> · {session.branch}</span>
        )}
      </div>
    </button>
  );
}

// ── Momentum Queues ───────────────────────────────────────────────

interface QueueConfig {
  key: keyof Pick<DashboardTaskMomentum, "followUpNow" | "needsDecision" | "candidateToClose" | "stale" | "waiting">;
  label: string;
  icon: React.ReactNode;
  color: string;
  emptyHint?: string;
}

const QUEUE_CONFIGS: QueueConfig[] = [
  {
    key: "followUpNow",
    label: "Follow up now",
    icon: <Bell size={13} />,
    color: "text-warning",
    emptyHint: "Nothing due for follow-up",
  },
  {
    key: "needsDecision",
    label: "Needs decision",
    icon: <HelpCircle size={13} />,
    color: "text-warning",
    emptyHint: "No pending decisions",
  },
  {
    key: "waiting",
    label: "Waiting on",
    icon: <Hourglass size={13} />,
    color: "text-text-secondary",
    emptyHint: "Nothing blocked waiting",
  },
  {
    key: "candidateToClose",
    label: "Candidate to close",
    icon: <Archive size={13} />,
    color: "text-success",
    emptyHint: "No tasks ready to close",
  },
  {
    key: "stale",
    label: "Stale tasks",
    icon: <AlertTriangle size={13} />,
    color: "text-error",
    emptyHint: "No stale tasks",
  },
];

function MomentumQueues({
  momentum,
  onSelectTask,
}: {
  momentum: DashboardTaskMomentum;
  onSelectTask: (id: string) => void;
}) {
  const activeQueues = QUEUE_CONFIGS.filter((q) => momentum[q.key].length > 0);
  if (activeQueues.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className={UI.text.sectionTitle}>
        Attention
      </h2>
      <div className="divide-y divide-border rounded-lg border border-border bg-bg-surface">
        {activeQueues.map((q) => (
          <MomentumQueueSection
            key={q.key}
            config={q}
            tasks={momentum[q.key]}
            onSelectTask={onSelectTask}
          />
        ))}
      </div>
    </div>
  );
}

function MomentumQueueSection({
  config,
  tasks,
  onSelectTask,
}: {
  config: QueueConfig;
  tasks: DashboardActiveTask[];
  onSelectTask: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-bg-hover transition-colors text-left"
      >
        <span className={config.color}>{config.icon}</span>
        <span className="text-xs font-semibold text-text-secondary flex-1">{config.label}</span>
        <span className="text-[11px] text-text-faint mr-1">{tasks.length}</span>
        {expanded
          ? <ChevronDown size={13} className="text-text-faint shrink-0" />
          : <ChevronRight size={13} className="text-text-faint shrink-0" />
        }
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {tasks.map((entry) => (
            <MomentumTaskRow
              key={entry.task.id}
              entry={entry}
              queueKey={config.key}
              onSelect={() => onSelectTask(entry.task.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MomentumTaskRow({
  entry,
  queueKey,
  onSelect,
}: {
  entry: DashboardActiveTask;
  queueKey: QueueConfig["key"];
  onSelect: () => void;
}) {
  const t = entry.task;
  const completionState = getTaskCompletionState(t, {
    totalChecklistItems: entry.checklistSummary.total,
    completedChecklistItems: entry.checklistSummary.done,
    openChecklistItems: entry.checklistSummary.open,
    linkedSessions: t.sessionIds.length,
    busySessions: entry.hasBusySession ? 1 : 0,
    linkedPullRequests: entry.prSummary.total,
    activePullRequests: entry.prSummary.active,
    unknownPullRequests: entry.prSummary.unknown,
  });
  const hint = queueKey === "followUpNow" && t.nextTouchAt
    ? `Touch by ${new Date(t.nextTouchAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`
    : queueKey === "needsDecision" && t.nextAction
      ? t.nextAction
      : queueKey === "waiting" && t.waitingOn
        ? `Waiting: ${t.waitingOn}`
        : queueKey === "candidateToClose"
          ? completionState.ctaDescription
          : queueKey === "stale"
            ? `Last activity ${timeAgo(entry.lastActivity)}`
            : undefined;

  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-4 py-2 hover:bg-bg-hover transition-colors flex items-center gap-3 group"
    >
      <div className="flex-1 min-w-0">
        <span className="text-sm text-text-primary truncate block group-hover:text-accent transition-colors">
          {t.title}
        </span>
        {hint && (
          <span className="text-xs text-text-faint truncate block mt-0.5">{hint}</span>
        )}
      </div>
      {entry.hasBusySession && (
        <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse shrink-0" />
      )}
    </button>
  );
}
