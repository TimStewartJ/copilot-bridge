import { useQuery } from "@tanstack/react-query";
import { fetchFeed, type FeedQueryFilters } from "../../api";
import { queryKeys } from "../../queryClient";

export function useFeedQuery(filters: FeedQueryFilters = {}) {
  return useQuery({
    queryKey: queryKeys.feed(filters),
    queryFn: () => fetchFeed(filters),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
