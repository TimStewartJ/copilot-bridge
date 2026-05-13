import { useMemo, useState } from "react";
import { useDashboardQuery } from "../hooks/queries/useDashboard";
import { useFeedQuery } from "../hooks/queries/useFeed";
import { useDashboardChecklist } from "../hooks/useDashboardChecklist";
import DashboardChecklist from "./DashboardChecklist";
import DashboardFeed from "./DashboardFeed";
import DashboardTabs, { type DashboardTab } from "./DashboardTabs";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { dashboardChecklistCountClass } from "./dashboard-checklist-helpers";

const DASHBOARD_TAB_STORAGE_KEY = "dashboard-active-tab";

interface DashboardProps {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  onStartPromptSession: (prompt: string, taskId?: string) => Promise<string>;
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

function getSavedDashboardTab(): DashboardTab {
  try {
    const val = localStorage.getItem(DASHBOARD_TAB_STORAGE_KEY);
    if (val === "checklist" || val === "feed") return val;
  } catch {}
  return "checklist";
}

export default function Dashboard({
  onSelectTask,
  onSelectSession,
  onStartPromptSession,
  scrollRestoration,
}: DashboardProps) {
  const { data, isLoading: loading, refetch: refetchDashboard } = useDashboardQuery();
  const checklist = useDashboardChecklist(data);
  const [showResolvedFeed, setShowResolvedFeed] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>(getSavedDashboardTab);
  const feedFilters = useMemo(() => ({
    limit: 100,
    ...(showResolvedFeed ? { includeDismissed: true } : {}),
  }), [showResolvedFeed]);
  const {
    data: feedCards = [],
    isLoading: feedLoading,
    refetch: refetchFeed,
  } = useFeedQuery(feedFilters);

  const handleTabChange = (tab: DashboardTab) => {
    setActiveTab(tab);
    try { localStorage.setItem(DASHBOARD_TAB_STORAGE_KEY, tab); } catch {}
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
          <DashboardTabs
            activeTab={activeTab}
            onTabChange={handleTabChange}
            checklistCount={checklist.visibleOpenChecklistItems.length}
            checklistCountClass={dashboardChecklistCountClass(checklist.checklistIndicator.state)}
            checklistCountTitle={checklist.checklistIndicatorLabel ?? undefined}
            feedCount={feedCards.length}
          />
          <DashboardFeed
            active={activeTab === "feed"}
            feedCards={feedCards}
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
