import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { getDashboardTabFromPathname, getDashboardTabPath } from "../lib/dashboard-routes";
import {
  useDashboardQuery,
  useFocusAlertPagesQuery,
  useFocusDecisionPagesQuery,
  useFocusSnapshotQuery,
} from "../hooks/queries/useDashboard";
import { useSettingsQuery } from "../hooks/queries/useSettings";
import { useWorkMapQuery } from "../hooks/queries/useWorkMap";
import { useDashboardChecklist } from "../hooks/useDashboardChecklist";
import DashboardFocus, { getDashboardFocusCount, getDueFollowUpTasks } from "./DashboardFocus";
import DashboardTabs from "./DashboardTabs";
import DashboardWorkMap from "./DashboardWorkMap";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { dashboardChecklistCountClass } from "./dashboard-checklist-helpers";
import type { Task, TaskGroup, WorkMapWorkItem } from "../api";
import { loadWorkMapFilters } from "../work-map-filter-state";
import { queryKeys } from "../queryClient";
import { readFocusSubjectLink, setFocusSubjectLink } from "../lib/focus-subject-links";
import { focusDueHandoffCount } from "../focus-view-model";

interface DashboardProps {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onCreateTaskForWorkItem: (workItem: WorkMapWorkItem) => Promise<void>;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  onStartPromptSession: (
    prompt: string,
    taskId?: string,
    options?: { navigateOnError?: boolean },
  ) => Promise<string>;
  tasks?: Task[];
  taskGroups?: TaskGroup[];
  scrollRestoration?: PullToRefreshScrollRestoration;
}

function DashboardSkeleton({ widthClass }: { widthClass: string }) {
  return (
    <LoadingSkeletonRegion
      isLoading
      label="Loading dashboard"
      className="flex-1 min-h-0 overflow-y-auto"
    >
      <div className={`${widthClass} mx-auto space-y-4 px-4 py-6 md:px-6 xl:px-8`}>
        <div className="flex items-center justify-between">
          <Skeleton height={12} width={132} shape="pill" />
          <Skeleton height={12} width={88} shape="pill" />
        </div>
        <SkeletonCard className="space-y-2 p-3">
          <Skeleton height={18} width={90} />
          <SkeletonText lines={1} widths={["65%"]} />
          <div className="flex flex-wrap gap-2">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} height={32} width={85} shape="pill" />)}</div>
        </SkeletonCard>
        <div className="grid gap-4 xl:grid-cols-12">
          <SkeletonCard className="space-y-3 xl:col-span-7">
            <Skeleton height={18} width={120} />
            <SkeletonText lines={4} widths={["92%", "74%", "88%", "56%"]} />
          </SkeletonCard>
          <SkeletonCard className="space-y-3 xl:col-span-5">
            <Skeleton height={18} width={112} />
            <SkeletonText lines={4} widths={["84%", "68%", "90%", "52%"]} />
          </SkeletonCard>
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

export default function Dashboard({
  onSelectTask,
  onCreateTaskForWorkItem,
  onSelectSession,
  onStartPromptSession,
  tasks = [],
  taskGroups = [],
  scrollRestoration,
}: DashboardProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const notification = useMemo(() => readFocusSubjectLink(location.search), [location.search]);
  const historyQuery = useMemo(() => new URLSearchParams(location.search).get("historyQuery")?.trim() || undefined, [location.search]);
  const queryClient = useQueryClient();
  const {
    data,
    isLoading: loading,
    error: actionsError,
    dataUpdatedAt: actionsUpdatedAt,
    refetch: refetchDashboard,
  } = useDashboardQuery();
  const { data: settings, isLoading: settingsLoading } = useSettingsQuery();
  const focusQuery = useFocusSnapshotQuery();
  const alertQuery = useFocusAlertPagesQuery();
  const decisionQuery = useFocusDecisionPagesQuery();
  const checklist = useDashboardChecklist(data);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [includeArchivedWorkMap, setIncludeArchivedWorkMap] = useState(
    () => loadWorkMapFilters().includeArchived,
  );
  const [assignedToMeWorkMap, setAssignedToMeWorkMap] = useState(
    () => loadWorkMapFilters().assignedToMeOnly,
  );
  const requestedTab = getDashboardTabFromPathname(location.pathname);
  const workMapEnabled = Boolean(settings?.providers?.ado);
  const activeTab = requestedTab === "work-map" && !settingsLoading && !workMapEnabled
    ? "focus"
    : requestedTab;
  const workMapQuery = useWorkMapQuery(
    workMapEnabled && activeTab === "work-map",
    includeArchivedWorkMap,
    assignedToMeWorkMap,
  );
  const alerts = useMemo(
    () => alertQuery.data?.pages.flatMap((page) => page.objects) ?? [],
    [alertQuery.data],
  );
  const decisions = useMemo(
    () => decisionQuery.data?.pages.flatMap((page) => page.objects) ?? [],
    [decisionQuery.data],
  );
  const alertTotal = alertQuery.data?.pages[0]?.total ?? focusQuery.data?.alertTotal ?? null;
  const decisionTotal = decisionQuery.data?.pages[0]?.total ?? focusQuery.data?.decisionTotal ?? null;
  const dueFollowUpCount = useMemo(
    () => getDueFollowUpTasks(tasks, new Date(nowMs)).length,
    [nowMs, tasks],
  );
  const focusCount = getDashboardFocusCount(
    checklist,
    (alertTotal ?? 0) + (decisionTotal ?? 0),
    dueFollowUpCount,
    focusDueHandoffCount(focusQuery.data, nowMs) ?? 0,
  );
  const focusIndicatorState = (focusDueHandoffCount(focusQuery.data, nowMs) ?? 0) > 0 || checklist.checklistIndicator.state === "overdue"
    ? "overdue"
    : focusCount > 0
      ? "due-today"
      : "none";
  const dashboardWidthClass = activeTab === "work-map" ? "max-w-6xl" : "max-w-[1440px]";

  const refreshFocus = async () => {
    await Promise.all([
      refetchDashboard(),
      focusQuery.refetch(),
      alertQuery.refetch(),
      decisionQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: queryKeys.focusRoot }),
      queryClient.invalidateQueries({ queryKey: queryKeys.openChecklistItems }),
    ]);
  };

  const handleRefresh = async () => {
    if (workMapEnabled && activeTab === "work-map") {
      await Promise.all([refreshFocus(), workMapQuery.refetch()]);
      return;
    }
    await refreshFocus();
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (settingsLoading || workMapEnabled || requestedTab !== "work-map") return;
    navigate(getDashboardTabPath("focus"), { replace: true });
  }, [navigate, requestedTab, settingsLoading, workMapEnabled]);

  if (loading && !data && !focusQuery.data && alerts.length === 0 && decisions.length === 0 && !notification.target && !notification.error) {
    return <DashboardSkeleton widthClass={dashboardWidthClass} />;
  }

  return (
    <div className="flex-1 min-h-0 relative">
      <PullToRefresh
        onRefresh={handleRefresh}
        className="absolute inset-0"
        scrollRestoration={scrollRestoration}
      >
        <div className={`${dashboardWidthClass} mx-auto space-y-3 px-4 py-6 md:px-6 xl:px-8`}>
          <DashboardTabs
            activeTab={activeTab}
            onTabChange={(tab) => navigate(getDashboardTabPath(tab))}
            focusCount={focusCount}
            focusCountClass={dashboardChecklistCountClass(focusIndicatorState)}
            focusCountTitle={focusCount > 0 ? `${focusCount} item${focusCount === 1 ? "" : "s"} need attention` : undefined}
            showWorkMap={workMapEnabled}
            workMapCount={workMapQuery.data?.workItems.length}
          />
          <DashboardFocus
            active={activeTab === "focus"}
            tabbed={workMapEnabled}
            initialHistoryQuery={historyQuery}
            checklist={checklist}
            tasks={tasks}
            taskGroups={taskGroups}
            focusSnapshot={focusQuery.data}
            alertTotal={alertTotal}
            decisionTotal={decisionTotal}
            alerts={alerts}
            decisions={decisions}
            alertsLoading={alertQuery.isLoading}
            alertsHasMore={Boolean(alertQuery.hasNextPage)}
            alertsLoadingMore={alertQuery.isFetchingNextPage}
            decisionsLoading={decisionQuery.isLoading}
            decisionsHasMore={Boolean(decisionQuery.hasNextPage)}
            decisionsLoadingMore={decisionQuery.isFetchingNextPage}
            focusLoading={focusQuery.isLoading}
            focusError={focusQuery.error}
            actionsLoading={loading}
            actionsError={actionsError}
            actionsUpdatedAt={actionsUpdatedAt}
            alertsUpdatedAt={alertQuery.dataUpdatedAt}
            decisionsUpdatedAt={decisionQuery.dataUpdatedAt}
            alertsError={alertQuery.error}
            decisionsError={decisionQuery.error}
            nowMs={nowMs}
            onSelectTask={onSelectTask}
            onSelectSession={onSelectSession}
            onStartPromptSession={onStartPromptSession}
            onLoadMoreAlerts={() => alertQuery.fetchNextPage()}
            onLoadMoreDecisions={() => decisionQuery.fetchNextPage()}
            onRetryFocus={() => Promise.all([
              refetchDashboard(),
              focusQuery.refetch(),
              alertQuery.refetch(),
              decisionQuery.refetch(),
            ])}
            onRefresh={refreshFocus}
            notificationTarget={notification.target}
            notificationError={notification.error}
            onCloseNotification={() => navigate({ pathname: location.pathname, search: setFocusSubjectLink(location.search, null).toString(), hash: location.hash }, { replace: true })}
            onInspectSubject={(target) => navigate({ pathname: location.pathname, search: setFocusSubjectLink(location.search, target).toString(), hash: location.hash })}
          />
          <DashboardWorkMap
            active={activeTab === "work-map"}
            data={workMapQuery.data}
            isLoading={workMapQuery.isLoading}
            error={workMapQuery.error}
            isRefreshing={workMapQuery.isRefreshing}
            onRefresh={workMapQuery.refresh}
            includeArchived={includeArchivedWorkMap}
            onIncludeArchivedChange={setIncludeArchivedWorkMap}
            assignedToMeOnly={assignedToMeWorkMap}
            onAssignedToMeChange={setAssignedToMeWorkMap}
            onSelectTask={onSelectTask}
            onCreateTaskForWorkItem={onCreateTaskForWorkItem}
          />
        </div>
      </PullToRefresh>
    </div>
  );
}
