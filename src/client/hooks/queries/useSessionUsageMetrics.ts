import { useQuery } from "@tanstack/react-query";
import { fetchSessionUsageMetrics } from "../../api";
import { queryClient, queryKeys } from "../../queryClient";

export function useSessionUsageMetricsQuery(
  sessionId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const enabled = Boolean(sessionId) && (options?.enabled ?? true);
  return useQuery({
    queryKey: queryKeys.sessionUsageMetrics(sessionId ?? ""),
    queryFn: ({ signal }) => fetchSessionUsageMetrics(sessionId!, { signal }),
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 0,
  }, queryClient);
}
