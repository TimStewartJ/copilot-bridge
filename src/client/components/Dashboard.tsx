import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getDashboardTabPath, getExplicitDashboardTabFromPathname, getRememberedDashboardTabFromPathname, setLastDashboardTab } from "../lib/dashboard-routes";
import { useDashboardQuery } from "../hooks/queries/useDashboard";
import { useFeedKindStatsQuery, useFeedPagesQuery } from "../hooks/queries/useFeed";
import { useDashboardChecklist } from "../hooks/useDashboardChecklist";
import DashboardChecklist from "./DashboardChecklist";
import DashboardFeed, { type FeedFilterState } from "./DashboardFeed";
import DashboardTabs from "./DashboardTabs";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";
import { dashboardChecklistCountClass } from "./dashboard-checklist-helpers";
import type { FeedCard, Task, TaskGroup } from "../api";

const ACTIVE_FEED_PAGE_SIZE = 50;
const RESOLVED_FEED_PAGE_SIZE = 50;

function parseFeedTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareTimestampDesc(a: string, b: string): number {
  return parseFeedTimestamp(b) - parseFeedTimestamp(a);
}

function compareIdDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

function compareActiveFeedCards(a: FeedCard, b: FeedCard): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return compareTimestampDesc(a.createdAt, b.createdAt) || b.id.localeCompare(a.id);
}

function compareResolvedFeedCards(a: FeedCard, b: FeedCard): number {
  return compareTimestampDesc(a.statusChangedAt, b.statusChangedAt)
    || compareTimestampDesc(a.updatedAt, b.updatedAt)
    || compareIdDesc(a.id, b.id);
}

function feedCardFreshness(card: FeedCard): number {
  return card.status === "active"
    ? parseFeedTimestamp(card.updatedAt)
    : Math.max(parseFeedTimestamp(card.statusChangedAt), parseFeedTimestamp(card.updatedAt));
}

export function mergeDashboardFeedCards(activeCards: FeedCard[], resolvedCards: FeedCard[]): FeedCard[] {
  const latestById = new Map<string, FeedCard>();
  for (const card of [...activeCards, ...resolvedCards]) {
    const existing = latestById.get(card.id);
    if (!existing || feedCardFreshness(card) >= feedCardFreshness(existing)) {
      latestById.set(card.id, card);
    }
  }
  const merged = Array.from(latestById.values());
  return [
    ...merged.filter((card) => card.status === "active").sort(compareActiveFeedCards),
    ...merged.filter((card) => card.status !== "active").sort(compareResolvedFeedCards),
  ];
}

function flattenFeedPages(data: { pages: Array<{ cards: FeedCard[] }> } | undefined): FeedCard[] {
  return data?.pages.flatMap((page) => page.cards) ?? [];
}

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
  const [feedFilter, setFeedFilter] = useState<FeedFilterState>({ kind: "", keyPrefix: "" });
  const activeTab = getRememberedDashboardTabFromPathname(location.pathname);
  const explicitActiveTab = getExplicitDashboardTabFromPathname(location.pathname);
  const handleFeedFilterChange = useCallback((patch: Partial<FeedFilterState>) => {
    setFeedFilter((prev) => ({ ...prev, ...patch }));
  }, []);
  const feedFilterFragment = useMemo(() => {
    const fragment: { kind?: string; keyPrefix?: string } = {};
    const kind = feedFilter.kind.trim();
    const keyPrefix = feedFilter.keyPrefix.trim();
    if (kind) fragment.kind = kind;
    if (keyPrefix) fragment.keyPrefix = keyPrefix;
    return fragment;
  }, [feedFilter]);
  const activeFeedFilters = useMemo(
    () => ({ ...feedFilterFragment, limit: ACTIVE_FEED_PAGE_SIZE }),
    [feedFilterFragment],
  );
  const doneFeedFilters = useMemo(
    () => ({ ...feedFilterFragment, status: "done" as const, limit: RESOLVED_FEED_PAGE_SIZE }),
    [feedFilterFragment],
  );
  const dismissedFeedFilters = useMemo(
    () => ({ ...feedFilterFragment, status: "dismissed" as const, limit: RESOLVED_FEED_PAGE_SIZE }),
    [feedFilterFragment],
  );
  const activeFeedQuery = useFeedPagesQuery(activeFeedFilters);
  const doneFeedQuery = useFeedPagesQuery(doneFeedFilters, { enabled: showResolvedFeed });
  const dismissedFeedQuery = useFeedPagesQuery(dismissedFeedFilters, { enabled: showResolvedFeed });
  const kindStatsParams = useMemo(
    () => ({ keyPrefix: feedFilterFragment.keyPrefix }),
    [feedFilterFragment.keyPrefix],
  );
  const kindStatsQuery = useFeedKindStatsQuery(kindStatsParams, { enabled: activeTab === "feed" });
  const activeFeedCards = useMemo(() => flattenFeedPages(activeFeedQuery.data), [activeFeedQuery.data]);
  const doneFeedCards = useMemo(() => flattenFeedPages(doneFeedQuery.data), [doneFeedQuery.data]);
  const dismissedFeedCards = useMemo(() => flattenFeedPages(dismissedFeedQuery.data), [dismissedFeedQuery.data]);
  const resolvedFeedCards = useMemo(
    () => showResolvedFeed ? [...doneFeedCards, ...dismissedFeedCards] : [],
    [dismissedFeedCards, doneFeedCards, showResolvedFeed],
  );
  const feedCards = useMemo(
    () => mergeDashboardFeedCards(activeFeedCards, resolvedFeedCards),
    [activeFeedCards, resolvedFeedCards],
  );
  const feedLoading = activeFeedQuery.isLoading || (showResolvedFeed && (doneFeedQuery.isLoading || dismissedFeedQuery.isLoading));

  const refetchFeed = async () => {
    const refetches: Array<Promise<unknown>> = [activeFeedQuery.refetch()];
    if (showResolvedFeed) {
      refetches.push(doneFeedQuery.refetch(), dismissedFeedQuery.refetch());
    }
    return Promise.all(refetches);
  };

  const loadMoreActiveFeed = async () => {
    if (!activeFeedQuery.hasNextPage || activeFeedQuery.isFetchingNextPage) return;
    await activeFeedQuery.fetchNextPage();
  };

  const loadMoreResolvedFeed = async () => {
    const refetches: Array<Promise<unknown>> = [];
    if (doneFeedQuery.hasNextPage && !doneFeedQuery.isFetchingNextPage) {
      refetches.push(doneFeedQuery.fetchNextPage());
    }
    if (dismissedFeedQuery.hasNextPage && !dismissedFeedQuery.isFetchingNextPage) {
      refetches.push(dismissedFeedQuery.fetchNextPage());
    }
    await Promise.all(refetches);
  };

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
            onTabChange={(tab) => {
              setLastDashboardTab(tab);
              navigate(getDashboardTabPath(tab));
            }}
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
            feedFilter={feedFilter}
            onFeedFilterChange={handleFeedFilterChange}
            kindStats={kindStatsQuery.data ?? null}
            kindStatsLoading={kindStatsQuery.isLoading}
            activeHasMore={Boolean(activeFeedQuery.hasNextPage)}
            resolvedHasMore={showResolvedFeed && Boolean(doneFeedQuery.hasNextPage || dismissedFeedQuery.hasNextPage)}
            activeLoadingMore={activeFeedQuery.isFetchingNextPage}
            resolvedLoadingMore={doneFeedQuery.isFetchingNextPage || dismissedFeedQuery.isFetchingNextPage}
            onToggleResolvedFeed={() => setShowResolvedFeed((value) => !value)}
            onSelectTask={(taskId) => onSelectTask(taskId)}
            onSelectSession={onSelectSession}
            onStartPromptSession={onStartPromptSession}
            onRefetchFeed={refetchFeed}
            onLoadMoreActive={loadMoreActiveFeed}
            onLoadMoreResolved={loadMoreResolvedFeed}
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
