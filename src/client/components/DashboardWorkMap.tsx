import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  BriefcaseBusiness,
  Plus,
  RefreshCw,
  Search,
  Workflow,
} from "lucide-react";
import type {
  WorkMapData,
  WorkMapPullRequest,
  WorkMapTask,
  WorkMapWorkItem,
} from "../api";
import { timeAgo } from "../time";
import { getDashboardPanelId, getDashboardTabId } from "../lib/dashboard-routes";
import EmptyState from "./shared/EmptyState";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { UI } from "./shared/design-system";
import { PullRequestPreviewCard, WorkItemPreviewCard } from "./WorkReferenceCards";
import {
  DEFAULT_WORK_MAP_FILTERS,
  loadWorkMapFilters,
  saveWorkMapFilters,
} from "../work-map-filter-state";

interface DashboardWorkMapProps {
  active: boolean;
  data?: WorkMapData;
  isLoading: boolean;
  error: unknown;
  isRefreshing: boolean;
  onRefresh: () => Promise<unknown>;
  includeArchived: boolean;
  onIncludeArchivedChange: (includeArchived: boolean) => void;
  assignedToMeOnly: boolean;
  onAssignedToMeChange: (assignedToMeOnly: boolean) => void;
  onSelectTask: (taskId: string) => void;
  onCreateTaskForWorkItem: (workItem: WorkMapWorkItem) => Promise<void>;
}

interface WorkItemCluster {
  workItem: WorkMapWorkItem;
  pullRequests: WorkMapPullRequest[];
  tasks: WorkMapTask[];
  attention: string[];
}

const CLOSED_WORK_ITEM_STATES = new Set([
  "closed",
  "completed",
  "done",
  "removed",
  "resolved",
]);
const VISIBLE_RELATIONSHIP_STEP = 20;

function isClosedWorkItem(item: WorkMapWorkItem): boolean {
  return item.state ? CLOSED_WORK_ITEM_STATES.has(item.state.toLowerCase()) : false;
}

function taskTone(task: WorkMapTask): string {
  if (task.status === "archived") return UI.chip.faint;
  return task.kind === "ongoing" ? UI.chip.selected : UI.chip.info;
}

function taskAssociation(
  taskId: string,
  workItem: WorkMapWorkItem,
  pullRequests: WorkMapPullRequest[],
): string {
  const viaWorkItem = workItem.taskIds.includes(taskId);
  const viaPullRequest = pullRequests.some((pr) => pr.taskIds.includes(taskId));
  if (viaWorkItem && viaPullRequest) return "Linked to work item and PR";
  if (viaPullRequest) return "Linked to PR";
  return "Linked to work item";
}

function clusterAttention(
  workItem: WorkMapWorkItem,
  pullRequests: WorkMapPullRequest[],
  tasks: WorkMapTask[],
): string[] {
  const attention: string[] = [];
  if (isClosedWorkItem(workItem) && pullRequests.some((pr) => pr.status === "active")) {
    attention.push("Work item is closed while a related PR is active");
  }
  if (tasks.length === 0) {
    attention.push("No Bridge task tracks this relationship");
  } else if (tasks.every((task) => task.status === "archived") && !isClosedWorkItem(workItem)) {
    attention.push("Open ADO work is tracked only by archived Bridge tasks");
  }
  return attention;
}

function matchesCluster(cluster: WorkItemCluster, query: string): boolean {
  if (!query) return true;
  const values = [
    cluster.workItem.id,
    cluster.workItem.title,
    cluster.workItem.state,
    cluster.workItem.type,
    cluster.workItem.assignedTo,
    cluster.workItem.areaPath,
    ...cluster.pullRequests.flatMap((pr) => [
      String(pr.prId),
      pr.title,
      pr.repoName,
      pr.status,
    ]),
    ...cluster.tasks.flatMap((task) => [
      task.title,
      task.nextAction,
      task.waitingOn,
    ]),
  ];
  return values.some((value) => value?.toLowerCase().includes(query));
}

function matchesOrphanPullRequest(
  pullRequest: WorkMapPullRequest,
  tasks: WorkMapTask[],
  query: string,
): boolean {
  if (!query) return true;
  return [
    String(pullRequest.prId),
    pullRequest.title,
    pullRequest.repoName,
    pullRequest.status,
    ...tasks.flatMap((task) => [task.title, task.nextAction, task.waitingOn]),
  ].some((value) => value?.toLowerCase().includes(query));
}

function MetricCard({
  value,
  label,
  tone = "text-text-primary",
}: {
  value: number;
  label: string;
  tone?: string;
}) {
  return (
    <div
      aria-label={`${label}: ${value}`}
      className={`${UI.surface.cardInset} px-3 py-2.5`}
    >
      <div className={`text-xl font-semibold ${tone}`}>{value}</div>
      <div className={UI.text.metricLabel}>{label}</div>
    </div>
  );
}

function TaskCard({
  task,
  association,
  onSelectTask,
}: {
  task: WorkMapTask;
  association: string;
  onSelectTask: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectTask(task.id)}
      className={`${UI.surface.cardInset} w-full border-l-2 border-l-accent px-3 py-3 text-left transition-colors hover:bg-bg-hover`}
    >
      <div className="flex items-center gap-2">
        {task.status === "archived"
          ? <Archive size={13} className="text-text-faint" />
          : <BriefcaseBusiness size={13} className="text-accent" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {task.title}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${taskTone(task)}`}>
          {task.status === "archived" ? "Archived" : task.kind === "ongoing" ? "Ongoing" : "Task"}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-text-faint">{association}</div>
      {(task.nextAction || task.waitingOn) && (
        <div className="mt-2 border-t border-border/70 pt-2 text-[10px] leading-relaxed text-text-muted">
          {task.waitingOn ? `Waiting on: ${task.waitingOn}` : `Next: ${task.nextAction}`}
        </div>
      )}
    </button>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="hidden min-w-0 items-center md:flex">
      <div className="h-px flex-1 bg-border" />
      <ArrowRight size={13} className="shrink-0 text-text-faint" aria-label={label} />
    </div>
  );
}

function StackLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 mt-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-text-faint first:mt-0 md:hidden">
      <div className="h-px flex-1 bg-border" />
      <span>{children}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function WorkMapSkeleton() {
  return (
    <LoadingSkeletonRegion isLoading label="Loading work map" className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonCard key={index}>
            <Skeleton height={22} width={42} />
            <Skeleton height={10} width={88} className="mt-2" />
          </SkeletonCard>
        ))}
      </div>
      <SkeletonCard className="grid gap-3 p-4 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index}>
            <SkeletonText lines={3} widths={["35%", "90%", "62%"]} />
          </div>
        ))}
      </SkeletonCard>
    </LoadingSkeletonRegion>
  );
}

export default function DashboardWorkMap({
  active,
  data,
  isLoading,
  error,
  isRefreshing,
  onRefresh,
  includeArchived,
  onIncludeArchivedChange,
  assignedToMeOnly,
  onAssignedToMeChange,
  onSelectTask,
  onCreateTaskForWorkItem,
}: DashboardWorkMapProps) {
  const [search, setSearch] = useState(() => loadWorkMapFilters().search);
  const [openAdoOnly, setOpenAdoOnly] = useState(() => loadWorkMapFilters().openAdoOnly);
  const [gapsOnly, setGapsOnly] = useState(() => loadWorkMapFilters().gapsOnly);
  const [visibleRelationshipCount, setVisibleRelationshipCount] = useState(VISIBLE_RELATIONSHIP_STEP);
  const [creatingTaskForWorkItemId, setCreatingTaskForWorkItemId] = useState<string | null>(null);
  const [createTaskError, setCreateTaskError] = useState<string | null>(null);

  const model = useMemo(() => {
    if (!data) {
      return {
        clusters: [] as WorkItemCluster[],
        orphanPullRequests: [] as Array<{ pullRequest: WorkMapPullRequest; tasks: WorkMapTask[] }>,
      };
    }
    const taskById = new Map(data.tasks.map((task) => [task.id, task]));
    const pullRequestByKey = new Map(data.pullRequests.map((pr) => [pr.key, pr]));
    const clusters = data.workItems.map((workItem) => {
      const pullRequests = workItem.pullRequestKeys
        .map((key) => pullRequestByKey.get(key))
        .filter((pr): pr is WorkMapPullRequest => Boolean(pr));
      const taskIds = new Set([
        ...workItem.taskIds,
        ...pullRequests.flatMap((pr) => pr.taskIds),
      ]);
      const tasks = [...taskIds]
        .map((taskId) => taskById.get(taskId))
        .filter((task): task is WorkMapTask => Boolean(task));
      return {
        workItem,
        pullRequests,
        tasks,
        attention: clusterAttention(workItem, pullRequests, tasks),
      };
    });
    const orphanPullRequests = data.pullRequests
      .filter((pr) => pr.workItemIds.length === 0)
      .map((pullRequest) => ({
        pullRequest,
        tasks: pullRequest.taskIds
          .map((taskId) => taskById.get(taskId))
          .filter((task): task is WorkMapTask => Boolean(task)),
      }));
    return {
      clusters,
      orphanPullRequests,
    };
  }, [data]);

  const normalizedSearch = search.trim().toLowerCase();
  const visibleClusters = model.clusters.filter((cluster) => {
    if (assignedToMeOnly && !cluster.workItem.assignedToCurrentUser) {
      return false;
    }
    if (openAdoOnly && isClosedWorkItem(cluster.workItem)
      && !cluster.pullRequests.some((pr) => pr.status === "active")) {
      return false;
    }
    if (gapsOnly && cluster.attention.length === 0) return false;
    return matchesCluster(cluster, normalizedSearch);
  });
  const visibleOrphans = model.orphanPullRequests.filter(({ pullRequest, tasks }) => {
    if (assignedToMeOnly) return false;
    if (openAdoOnly && pullRequest.status !== "active") return false;
    return matchesOrphanPullRequest(pullRequest, tasks, normalizedSearch);
  });
  const visibleMetrics = useMemo(() => {
    const pullRequestKeys = new Set(visibleOrphans.map(({ pullRequest }) => pullRequest.key));
    const taskIds = new Set(visibleOrphans.flatMap(({ tasks }) => tasks.map((task) => task.id)));
    for (const cluster of visibleClusters) {
      for (const pullRequest of cluster.pullRequests) pullRequestKeys.add(pullRequest.key);
      for (const task of cluster.tasks) taskIds.add(task.id);
    }
    return {
      workItems: visibleClusters.length,
      pullRequests: pullRequestKeys.size,
      tasks: taskIds.size,
      attention: visibleClusters.filter((cluster) => cluster.attention.length > 0).length
        + visibleOrphans.length,
    };
  }, [visibleClusters, visibleOrphans]);
  const visibleTotal = visibleClusters.length + visibleOrphans.length;
  const renderedClusters = visibleClusters.slice(0, visibleRelationshipCount);
  const remainingSlots = Math.max(0, visibleRelationshipCount - renderedClusters.length);
  const renderedOrphans = visibleOrphans.slice(0, remainingSlots);
  const renderedTotal = renderedClusters.length + renderedOrphans.length;

  useEffect(() => {
    setVisibleRelationshipCount(VISIBLE_RELATIONSHIP_STEP);
  }, [assignedToMeOnly, gapsOnly, includeArchived, normalizedSearch, openAdoOnly]);

  useEffect(() => {
    saveWorkMapFilters({
      search,
      assignedToMeOnly,
      openAdoOnly,
      gapsOnly,
      includeArchived,
    });
  }, [assignedToMeOnly, gapsOnly, includeArchived, openAdoOnly, search]);

  const hasActiveFilters = Boolean(
    search || assignedToMeOnly || openAdoOnly || gapsOnly || includeArchived,
  );
  const resetFilters = () => {
    setSearch(DEFAULT_WORK_MAP_FILTERS.search);
    onAssignedToMeChange(DEFAULT_WORK_MAP_FILTERS.assignedToMeOnly);
    setOpenAdoOnly(DEFAULT_WORK_MAP_FILTERS.openAdoOnly);
    setGapsOnly(DEFAULT_WORK_MAP_FILTERS.gapsOnly);
    onIncludeArchivedChange(DEFAULT_WORK_MAP_FILTERS.includeArchived);
  };
  const createTaskForWorkItem = async (workItem: WorkMapWorkItem) => {
    setCreatingTaskForWorkItemId(workItem.id);
    setCreateTaskError(null);
    try {
      await onCreateTaskForWorkItem(workItem);
    } catch (error) {
      setCreateTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingTaskForWorkItemId(null);
    }
  };

  if (!active) return null;

  return (
    <section
      id={getDashboardPanelId("work-map")}
      role="tabpanel"
      aria-labelledby={getDashboardTabId("work-map")}
      tabIndex={0}
      className="space-y-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className={UI.text.pageKicker}>
            <Workflow size={14} />
            Connected work
          </div>
          <h2 className="mt-1 text-xl font-semibold text-text-primary">Work map</h2>
          <p className="mt-1 text-xs text-text-muted">
            ADO work items and pull requests connected to their Bridge tasks.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void onRefresh(); }}
          disabled={isRefreshing}
          className={`${UI.button.secondary} inline-flex items-center justify-center gap-1.5 self-start disabled:opacity-50`}
        >
          <RefreshCw size={12} className={isRefreshing ? "animate-spin" : ""} />
          {isRefreshing ? "Refreshing..." : "Refresh ADO"}
        </button>
      </div>

      {isLoading && !data ? <WorkMapSkeleton /> : null}

      {error && !data ? (
        <div className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error" role="alert">
          <div className="font-medium">Work map could not be loaded</div>
          <button
            type="button"
            onClick={() => { void onRefresh(); }}
            className="mt-2 text-xs font-medium underline underline-offset-2"
          >
            Try again
          </button>
        </div>
      ) : null}

      {data && !data.enabled ? (
        <EmptyState
          message="Azure DevOps is not configured"
          sub="Add an ADO organization and project in Settings to enable the Work Map."
        />
      ) : null}

      {data?.enabled ? (
        <>
          {data.warnings.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>{data.warnings.join(" ")}</div>
              </div>
            </div>
          )}
          {createTaskError && (
            <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error" role="alert">
              Could not create the Bridge task: {createTaskError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <MetricCard value={visibleMetrics.workItems} label="ADO work items" />
            <MetricCard value={visibleMetrics.pullRequests} label="Related PRs" />
            <MetricCard value={visibleMetrics.tasks} label="Bridge tasks" />
            <MetricCard
              value={visibleMetrics.attention}
              label="Needs attention"
              tone={visibleMetrics.attention > 0 ? "text-warning" : "text-success"}
            />
          </div>

          <div className={`${UI.surface.cardInset} flex flex-col gap-2 p-2 sm:flex-row sm:items-center`}>
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-bg-primary px-2.5 py-2">
              <Search size={13} className="shrink-0 text-text-faint" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search work items, PRs, or tasks..."
                className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-faint"
              />
            </label>
            <div className="flex gap-1">
              <button
                type="button"
                aria-pressed={assignedToMeOnly}
                title={data.currentUser
                  ? `Show work assigned to ${data.currentUser.displayName}`
                  : "Show work assigned to the signed-in ADO user"}
                onClick={() => onAssignedToMeChange(!assignedToMeOnly)}
                className={`rounded-md px-2.5 py-2 text-[11px] font-medium transition-colors ${
                  assignedToMeOnly ? UI.chip.selected : "text-text-muted hover:bg-bg-hover"
                }`}
              >
                Assigned to me
              </button>
              <button
                type="button"
                aria-pressed={openAdoOnly}
                onClick={() => setOpenAdoOnly((value) => !value)}
                className={`rounded-md px-2.5 py-2 text-[11px] font-medium transition-colors ${
                  openAdoOnly ? UI.chip.selected : "text-text-muted hover:bg-bg-hover"
                }`}
              >
                Open ADO
              </button>
              <button
                type="button"
                aria-pressed={gapsOnly}
                onClick={() => setGapsOnly((value) => !value)}
                className={`rounded-md px-2.5 py-2 text-[11px] font-medium transition-colors ${
                  gapsOnly ? UI.chip.selected : "text-text-muted hover:bg-bg-hover"
                }`}
              >
                Gaps only
              </button>
              <button
                type="button"
                aria-pressed={includeArchived}
                onClick={() => onIncludeArchivedChange(!includeArchived)}
                className={`rounded-md px-2.5 py-2 text-[11px] font-medium transition-colors ${
                  includeArchived ? UI.chip.selected : "text-text-muted hover:bg-bg-hover"
                }`}
              >
                Archived tasks
              </button>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="rounded-md px-2.5 py-2 text-[11px] font-medium text-text-faint transition-colors hover:bg-bg-hover hover:text-text-primary"
                >
                  Reset
                </button>
              )}
            </div>
          </div>

          {data.workItems.length === 0 && data.pullRequests.length === 0 ? (
            <EmptyState
              message="No linked ADO work yet"
              sub="Link an ADO work item or pull request to a Bridge task and it will appear here."
            />
          ) : visibleClusters.length === 0 && visibleOrphans.length === 0 ? (
            <EmptyState
              message="No relationships match these filters"
              sub="Clear the search or turn off a filter to see more connected work."
            />
          ) : (
            <div className="space-y-3">
              {renderedClusters.map((cluster) => (
                <article key={cluster.workItem.id} className={`${UI.surface.card} overflow-hidden p-3 md:p-4`}>
                  {cluster.attention.length > 0 && (
                    <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>{cluster.attention.join(". ")}</span>
                    </div>
                  )}
                  <div className="grid items-center gap-0 md:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)_2rem_minmax(0,1fr)]">
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-faint">
                        ADO work item
                      </div>
                      <WorkItemPreviewCard item={cluster.workItem} />
                    </div>
                    <Connector label="Related pull requests" />
                    <div>
                      <StackLabel>Related pull requests</StackLabel>
                      <div className="mb-1.5 hidden text-[10px] font-semibold uppercase tracking-wide text-text-faint md:block">
                        Related pull requests
                      </div>
                      <div className="space-y-2">
                        {cluster.pullRequests.length > 0 ? cluster.pullRequests.map((pr) => (
                          <PullRequestPreviewCard key={pr.key} pullRequest={pr} />
                        )) : (
                          <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-text-faint">
                            No related PR discovered
                          </div>
                        )}
                      </div>
                    </div>
                    <Connector label="Bridge tasks" />
                    <div>
                      <StackLabel>Bridge tasks</StackLabel>
                      <div className="mb-1.5 hidden text-[10px] font-semibold uppercase tracking-wide text-text-faint md:block">
                        Bridge tasks
                      </div>
                      <div className="space-y-2">
                        {cluster.tasks.length > 0 ? cluster.tasks.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            association={taskAssociation(task.id, cluster.workItem, cluster.pullRequests)}
                            onSelectTask={onSelectTask}
                          />
                        )) : (
                          <button
                            type="button"
                            aria-label={`Create Bridge task for work item ${cluster.workItem.id}`}
                            disabled={creatingTaskForWorkItemId !== null}
                            onClick={() => { void createTaskForWorkItem(cluster.workItem); }}
                            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-warning/40 bg-warning/5 px-3 py-5 text-center text-xs font-medium text-warning transition-colors hover:border-warning/60 hover:bg-warning/10 disabled:cursor-wait disabled:opacity-50"
                          >
                            <Plus size={13} />
                            {creatingTaskForWorkItemId === cluster.workItem.id
                              ? "Creating Bridge task..."
                              : "No Bridge task - create one"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              ))}

              {renderedOrphans.map(({ pullRequest, tasks }) => (
                <article key={pullRequest.key} className={`${UI.surface.card} overflow-hidden p-3 md:p-4`}>
                  <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <span>This Bridge-linked PR has no related ADO work item.</span>
                  </div>
                  <div className="grid items-center gap-0 md:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)_2rem_minmax(0,1fr)]">
                    <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-text-faint">
                      No related work item
                    </div>
                    <Connector label="Pull request" />
                    <div>
                      <StackLabel>Pull request</StackLabel>
                      <PullRequestPreviewCard pullRequest={pullRequest} />
                    </div>
                    <Connector label="Bridge tasks" />
                    <div>
                      <StackLabel>Bridge tasks</StackLabel>
                      <div className="space-y-2">
                        {tasks.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            association="Linked to PR"
                            onSelectTask={onSelectTask}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
              {renderedTotal < visibleTotal && (
                <button
                  type="button"
                  onClick={() => setVisibleRelationshipCount((count) => count + VISIBLE_RELATIONSHIP_STEP)}
                  className={`${UI.button.secondary} mx-auto flex items-center justify-center`}
                >
                  Show {Math.min(VISIBLE_RELATIONSHIP_STEP, visibleTotal - renderedTotal)} more
                </button>
              )}
            </div>
          )}

          <div className="text-right text-[10px] text-text-faint">
            {data.org}/{data.project} - {data.includeArchived ? "active and archived tasks" : "active tasks"} - refreshed {timeAgo(data.generatedAt)}
          </div>
        </>
      ) : null}
    </section>
  );
}
