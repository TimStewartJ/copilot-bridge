import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getDashboardTabFromPathname, getDashboardTabPath, getExplicitDashboardTabFromPathname, setLastDashboardTab } from "../lib/dashboard-routes";
import { useDashboardQuery } from "../hooks/queries/useDashboard";
import { useFeedQuery } from "../hooks/queries/useFeed";
import { useDashboardChecklist } from "../hooks/useDashboardChecklist";
import DashboardChecklist from "./DashboardChecklist";
import DashboardFeed from "./DashboardFeed";
import DashboardTabs from "./DashboardTabs";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { dashboardChecklistCountClass } from "./dashboard-checklist-helpers";
import type { Task, TaskGroup } from "../api";

interface DashboardProps {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
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

export default function Dashboard({
  onSelectTask,
  onSelectSession,
  onStartPromptSession,
  tasks = [],
  taskGroups = [],
  scrollRestoration,
}: DashboardProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data, isLoading: loading, refetch: refetchDashboard } = useDashboardQuery();
  const checklist = useDashboardChecklist(data);
  const [showResolvedFeed, setShowResolvedFeed] = useState(false);
  const activeTab = getDashboardTabFromPathname(location.pathname);
  const explicitActiveTab = getExplicitDashboardTabFromPathname(location.pathname);
  const feedFilters = useMemo(() => ({
    limit: 100,
    ...(showResolvedFeed ? { includeDismissed: true } : {}),
  }), [showResolvedFeed]);
  const {
    data: feedCards = [],
    isLoading: feedLoading,
    refetch: refetchFeed,
  } = useFeedQuery(feedFilters);

  const handleRefresh = async () => {
    await Promise.all([refetchDashboard(), refetchFeed()]);
  };

  useEffect(() => {
    if (explicitActiveTab) setLastDashboardTab(explicitActiveTab);
  }, [explicitActiveTab]);

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
          <DashboardTabs
            activeTab={activeTab}
            onTabChange={(tab) => navigate(getDashboardTabPath(tab))}
            checklistCount={checklist.visibleOpenChecklistItems.length}
            checklistCountClass={dashboardChecklistCountClass(checklist.checklistIndicator.state)}
            checklistCountTitle={checklist.checklistIndicatorLabel ?? undefined}
            feedCount={feedCards.length}
          />
          <DashboardFeed
            active={activeTab === "feed"}
            feedCards={feedCards}
            tasks={tasks}
            taskGroups={taskGroups}
            feedLoading={feedLoading}
            showResolvedFeed={showResolvedFeed}
            onToggleResolvedFeed={() => setShowResolvedFeed((value) => !value)}
            onSelectTask={(taskId) => onSelectTask(taskId)}
            onSelectSession={onSelectSession}
            onStartPromptSession={onStartPromptSession}
            onRefetchFeed={refetchFeed}
          />
          <DashboardChecklist
            active={activeTab === "checklist"}
            checklist={checklist}
            onSelectTask={onSelectTask}
          />
        </div>
      </PullToRefresh>
    </div>
  );
}
