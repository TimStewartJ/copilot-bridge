import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { fetchFeed, fetchFeedPage, type FeedQueryFilters } from "../../api";
import { queryKeys } from "../../queryClient";

export function useFeedQuery(filters: FeedQueryFilters = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.feed(filters),
    queryFn: () => fetchFeed(filters),
    enabled: options.enabled ?? true,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

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
