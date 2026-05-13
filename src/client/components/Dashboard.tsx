import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createGlobalChecklistItem,
  deleteFeedCard,
  patchChecklistItem,
  patchFeedCard,
  type DashboardChecklistItem,
  type FeedCardStatus,
} from "../api";
import { useDashboardQuery } from "../hooks/queries/useDashboard";
import { useFeedQuery } from "../hooks/queries/useFeed";
import { GROUP_COLOR_DOT } from "../group-colors";
import EmptyState from "./shared/EmptyState";
import ChecklistItemRow from "./ChecklistItemRow";
import FeedCard from "./FeedCard";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import { ArrowUpDown, Check, CheckSquare, ChevronDown, ChevronRight, Inbox, Plus } from "lucide-react";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { UI } from "./shared/design-system";
import { describeHomeChecklistIndicator, getHomeChecklistIndicator, type HomeChecklistIndicatorState } from "../checklist-helpers";

type ChecklistSort = "deadline" | "task";
type DashboardTab = "checklist" | "feed";

const SORT_LABELS: Record<ChecklistSort, string> = {
  deadline: "Deadline",
  task: "By task",
};

const SORT_STORAGE_KEY = "dashboard-checklist-sort";
const COLLAPSE_STORAGE_KEY = "dashboard-checklist-collapsed";
const DASHBOARD_TAB_STORAGE_KEY = "dashboard-active-tab";

interface DashboardProps {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  scrollRestoration?: PullToRefreshScrollRestoration;
}

interface ChecklistGroup {
  key: string;
  taskId: string | null;
  taskTitle: string | null;
  taskGroupColor: string | null;
  checklistItems: DashboardChecklistItem[];
}

const TASK_STATUS_ORDER: Record<string, number> = { active: 0, done: 1, archived: 2 };

function DashboardSkeleton() {
  return (
    <LoadingSkeletonRegion
      isLoading
      label="Loading dashboard"
      className="flex-1 min-h-0 overflow-y-auto"
    >
      <div className="max-w-3xl mx-auto px-4 md:px-8 py-6 space-y-3">
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

function getCollapsedSet(): Set<string> {
  try {
    const val = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (val) return new Set(JSON.parse(val));
  } catch {}
  return new Set();
}

function getSavedDashboardTab(): DashboardTab {
  try {
    const val = localStorage.getItem(DASHBOARD_TAB_STORAGE_KEY);
    if (val === "checklist" || val === "feed") return val;
  } catch {}
  return "checklist";
}

export function dashboardChecklistCountClass(state: HomeChecklistIndicatorState): string {
  switch (state) {
    case "overdue":
      return "border-error/30 bg-error/10 text-error";
    case "due-today":
      return "border-warning/30 bg-warning/10 text-warning";
    default:
      return "border-border bg-bg-hover text-text-faint";
  }
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
      continue;
    }

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

  for (const entry of taskMap.values()) {
    entry.checklistItems.sort((a, b) => a.order - b.order);
  }
  globalChecklistItems.sort((a, b) => a.order - b.order);

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

export default function Dashboard({
  onSelectTask,
  onSelectSession,
  scrollRestoration,
}: DashboardProps) {
  const { data, isLoading: loading, refetch: refetchDashboard } = useDashboardQuery();
  const [localOpenChecklistItems, setLocalOpenChecklistItems] = useState<DashboardChecklistItem[]>([]);
  const [localCompletedChecklistItems, setLocalCompletedChecklistItems] = useState<DashboardChecklistItem[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showResolvedFeed, setShowResolvedFeed] = useState(false);
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [newChecklistItemText, setNewChecklistItemText] = useState("");
  const [checklistSort, setChecklistSort] = useState<ChecklistSort>(getSavedSort);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(getCollapsedSet);
  const [activeTab, setActiveTab] = useState<DashboardTab>(getSavedDashboardTab);
  const lastLocalChange = useRef(0);
  const feedFilters = useMemo(() => ({
    limit: 100,
    ...(showResolvedFeed ? { includeDismissed: true } : {}),
  }), [showResolvedFeed]);
  const {
    data: feedCards = [],
    isLoading: feedLoading,
    refetch: refetchFeed,
  } = useFeedQuery(feedFilters);

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
  const visibleOpenChecklistItems = useMemo(
    () => localOpenChecklistItems.filter((item) => !exitingIds.has(item.id)),
    [localOpenChecklistItems, exitingIds],
  );
  const checklistIndicator = useMemo(
    () => getHomeChecklistIndicator(visibleOpenChecklistItems),
    [visibleOpenChecklistItems],
  );
  const checklistIndicatorLabel = describeHomeChecklistIndicator(checklistIndicator);
  const checklistGroups = useMemo(
    () => groupChecklistItemsByTask(localOpenChecklistItems),
    [localOpenChecklistItems],
  );

  const handleTabChange = (tab: DashboardTab) => {
    setActiveTab(tab);
    try { localStorage.setItem(DASHBOARD_TAB_STORAGE_KEY, tab); } catch {}
  };

  const handleSortChange = (sort: ChecklistSort) => {
    setChecklistSort(sort);
    try { localStorage.setItem(SORT_STORAGE_KEY, sort); } catch {}
  };

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const handleAddChecklistItem = async (event: FormEvent) => {
    event.preventDefault();
    const text = newChecklistItemText.trim();
    if (!text) return;

    setNewChecklistItemText("");
    lastLocalChange.current = Date.now();
    const tempId = `temp-${Date.now()}`;
    const optimistic: DashboardChecklistItem = {
      id: tempId,
      taskId: null,
      text,
      done: false,
      order: 0,
      createdAt: new Date().toISOString(),
      taskTitle: null,
      taskGroupColor: null,
      taskOrder: 0,
      taskStatus: null,
      taskGroupId: null,
      taskGroupOrder: null,
    };
    setLocalOpenChecklistItems((prev) => [optimistic, ...prev]);

    try {
      const checklistItem = await createGlobalChecklistItem(text);
      setLocalOpenChecklistItems((prev) => prev.map((item) =>
        item.id === tempId
          ? {
            ...checklistItem,
            taskTitle: null,
            taskGroupColor: null,
            taskOrder: 0,
            taskStatus: null,
            taskGroupId: null,
            taskGroupOrder: null,
          }
          : item,
      ));
    } catch (err) {
      console.error("Failed to create checklist item:", err);
      setLocalOpenChecklistItems((prev) => prev.filter((item) => item.id !== tempId));
    }
  };

  const moveOpenItemToCompleted = (checklistItem: DashboardChecklistItem) => {
    setExitingIds((prev) => {
      const next = new Set(prev);
      next.delete(checklistItem.id);
      return next;
    });
    setLocalOpenChecklistItems((prev) => prev.filter((item) => item.id !== checklistItem.id));
    setLocalCompletedChecklistItems((prev) => [{ ...checklistItem, done: true }, ...prev]);
  };

  const updateOpenItem = (updated: Partial<DashboardChecklistItem> & { id: string }) => {
    lastLocalChange.current = Date.now();
    setLocalOpenChecklistItems((prev) => prev.map((item) =>
      item.id === updated.id ? { ...item, ...updated } : item,
    ));
  };

  const updateCompletedItem = (updated: Partial<DashboardChecklistItem> & { id: string }) => {
    lastLocalChange.current = Date.now();
    setLocalCompletedChecklistItems((prev) => prev.map((item) =>
      item.id === updated.id ? { ...item, ...updated } : item,
    ));
  };

  const handleFeedStatusChange = async (cardId: string, status: FeedCardStatus) => {
    await patchFeedCard(cardId, { status });
    await refetchFeed();
  };

  const handleFeedDelete = async (cardId: string) => {
    await deleteFeedCard(cardId);
    await refetchFeed();
  };

  const handleRefresh = async () => {
    await Promise.all([refetchDashboard(), refetchFeed()]);
  };

  if (loading && !data) return <DashboardSkeleton />;

  if (!data) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-text-muted text-sm">
        Failed to load dashboard
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative">
      <PullToRefresh
        onRefresh={handleRefresh}
        className="absolute inset-0"
        scrollRestoration={scrollRestoration}
      >
        <div className="max-w-3xl mx-auto px-4 md:px-8 py-6 space-y-3">
          <div className="flex rounded-lg border border-border bg-bg-surface p-1" role="tablist" aria-label="Dashboard sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "checklist"}
              onClick={() => handleTabChange("checklist")}
              className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === "checklist"
                  ? "bg-bg-primary text-text-primary shadow-sm"
                  : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
              }`}
            >
              <CheckSquare size={14} />
              <span>Checklist</span>
              {visibleOpenChecklistItems.length > 0 && (
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[11px] font-semibold leading-none ${dashboardChecklistCountClass(checklistIndicator.state)}`}
                  title={checklistIndicatorLabel ?? undefined}
                >
                  {visibleOpenChecklistItems.length}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "feed"}
              onClick={() => handleTabChange("feed")}
              className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === "feed"
                  ? "bg-bg-primary text-text-primary shadow-sm"
                  : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
              }`}
            >
              <Inbox size={14} />
              <span>Feed</span>
              {feedCards.length > 0 && (
                <span className="rounded-full border border-border bg-bg-hover px-1.5 py-0.5 text-[11px] font-semibold leading-none text-text-faint">
                  {feedCards.length}
                </span>
              )}
            </button>
          </div>

          {activeTab === "feed" && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className={UI.text.sectionTitle}>
                <Inbox size={14} />
                Feed
                {feedCards.length > 0 && (
                  <span className="text-text-faint font-normal">({feedCards.length})</span>
                )}
              </h2>
              <button
                type="button"
                onClick={() => setShowResolvedFeed((value) => !value)}
                className="text-[11px] px-1.5 py-0.5 rounded text-text-faint hover:text-text-secondary transition-colors"
              >
                {showResolvedFeed ? "Hide resolved" : "Show resolved"}
              </button>
            </div>

            {feedLoading && feedCards.length === 0 ? (
              <div className="space-y-2">
                <SkeletonCard className="space-y-3">
                  <div className="flex gap-2">
                    <Skeleton width={52} height={18} shape="pill" />
                    <Skeleton width={44} height={18} shape="pill" />
                  </div>
                  <SkeletonText lines={3} widths={["72%", "100%", "58%"]} />
                </SkeletonCard>
                <SkeletonCard className="space-y-3">
                  <div className="flex gap-2">
                    <Skeleton width={60} height={18} shape="pill" />
                    <Skeleton width={52} height={18} shape="pill" />
                  </div>
                  <SkeletonText lines={2} widths={["64%", "82%"]} />
                </SkeletonCard>
              </div>
            ) : feedCards.length > 0 ? (
              <div className="space-y-2">
                {feedCards.map((card) => (
                  <FeedCard
                    key={card.id}
                    card={card}
                    onSelectTask={(taskId) => onSelectTask(taskId)}
                    onSelectSession={onSelectSession}
                    onStatusChange={(feedCard, status) => handleFeedStatusChange(feedCard.id, status)}
                    onDelete={(feedCard) => handleFeedDelete(feedCard.id)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                message="No feed cards"
                sub="Agents can publish durable cards here for decisions, previews, artifacts, and summaries."
              />
            )}
          </section>
          )}

          {activeTab === "checklist" && (
          <>
          <div className="flex items-center justify-between">
            <h2 className={UI.text.sectionTitle}>
              <CheckSquare size={14} />
              Open Checklist
              {visibleOpenChecklistItems.length > 0 && (
                <span className="text-text-faint font-normal">
                  ({visibleOpenChecklistItems.length})
                </span>
              )}
            </h2>
            {localOpenChecklistItems.length > 1 && (
              <div className="flex items-center gap-1">
                <ArrowUpDown size={11} className="text-text-faint" />
                {(Object.keys(SORT_LABELS) as ChecklistSort[]).map((sort) => (
                  <button
                    key={sort}
                    onClick={() => handleSortChange(sort)}
                    className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${
                      checklistSort === sort
                        ? `${UI.chip.selected} font-medium`
                        : "text-text-faint hover:text-text-secondary"
                    }`}
                  >
                    {SORT_LABELS[sort]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={handleAddChecklistItem}>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-surface border border-border focus-within:border-accent transition-colors">
              <Plus size={14} className="text-text-faint shrink-0" />
              <input
                type="text"
                value={newChecklistItemText}
                onChange={(event) => setNewChecklistItemText(event.target.value)}
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
                    const visibleCount = group.checklistItems.filter((item) => !exitingIds.has(item.id)).length;
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
                                  if (exitingIds.has(checklistItem.id)) moveOpenItemToCompleted(checklistItem);
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
                                  onDeadlineChange={(deadline) => updateOpenItem({ id: checklistItem.id, deadline: deadline ?? undefined })}
                                  onUpdate={updateOpenItem}
                                  onDelete={() => {
                                    lastLocalChange.current = Date.now();
                                    setLocalOpenChecklistItems((prev) => prev.filter((item) => item.id !== checklistItem.id));
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
                        if (exitingIds.has(checklistItem.id)) moveOpenItemToCompleted(checklistItem);
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
                        onDeadlineChange={(deadline) => updateOpenItem({ id: checklistItem.id, deadline: deadline ?? undefined })}
                        onUpdate={updateOpenItem}
                        onDelete={() => {
                          lastLocalChange.current = Date.now();
                          setLocalOpenChecklistItems((prev) => prev.filter((item) => item.id !== checklistItem.id));
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
                    onClick={() => setShowCompleted((value) => !value)}
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
                            setLocalCompletedChecklistItems((prev) => prev.filter((item) => item.id !== checklistItem.id));
                            setLocalOpenChecklistItems((prev) => [...prev, { ...checklistItem, done: false }]);
                            await patchChecklistItem(checklistItem.id, { done: false });
                          }}
                          onUpdate={updateCompletedItem}
                          onDelete={() => {
                            lastLocalChange.current = Date.now();
                            setLocalCompletedChecklistItems((prev) => prev.filter((item) => item.id !== checklistItem.id));
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
          </>
          )}
        </div>
      </PullToRefresh>
    </div>
  );
}
