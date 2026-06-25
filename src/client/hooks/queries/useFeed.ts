import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { fetchFeedKindStats, fetchFeedPage, type FeedKindStatsParams, type FeedQueryFilters } from "../../api";
import { queryKeys } from "../../queryClient";

export function useFeedPagesQuery(filters: FeedQueryFilters = {}, options: { enabled?: boolean } = {}) {
  const queryFilters = { ...filters, paginated: true };
  return useInfiniteQuery({
    queryKey: queryKeys.feed(queryFilters),
    queryFn: ({ pageParam }) => fetchFeedPage({
      ...filters,
      cursor: typeof pageParam === "string" ? pageParam : undefined,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
    refetchOnWindowFocus: true,
  });
}

export function useFeedKindStatsQuery(
  params: FeedKindStatsParams = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.feedKindStats({ ...params }),
    queryFn: () => fetchFeedKindStats(params),
    enabled: options.enabled ?? true,
    refetchOnWindowFocus: true,
  });
}
