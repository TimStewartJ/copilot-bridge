import { useCallback } from "react";
import { queryOptions, type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCopilotUsage } from "../../api";
import { queryKeys } from "../../queryClient";

const COPILOT_USAGE_STALE_TIME = 5 * 60_000;

export function getCopilotUsageQueryOptions(options?: { refresh?: boolean }) {
  return queryOptions({
    queryKey: queryKeys.copilotUsage,
    queryFn: ({ signal }) => fetchCopilotUsage({ refresh: options?.refresh, signal }),
    staleTime: COPILOT_USAGE_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}

export async function refreshCopilotUsageQuery(queryClient: QueryClient) {
  await queryClient.cancelQueries({ queryKey: queryKeys.copilotUsage }, { silent: true });
  return queryClient.fetchQuery({
    ...getCopilotUsageQueryOptions({ refresh: true }),
    staleTime: 0,
  });
}

export function useCopilotUsageQuery() {
  const queryClient = useQueryClient();
  const query = useQuery(getCopilotUsageQueryOptions());

  const refresh = useCallback(async () => {
    return refreshCopilotUsageQuery(queryClient);
  }, [queryClient]);

  return {
    ...query,
    refresh,
  };
}
