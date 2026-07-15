import { useCallback } from "react";
import { queryOptions, type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCopilotUsage } from "../../api";
import { queryKeys } from "../../queryClient";

const COPILOT_USAGE_STALE_TIME = 5 * 60_000;
const COPILOT_USAGE_INDEX_POLL_INTERVAL = 2_000;

export interface CopilotUsageQueryScope {
  taskId?: string;
  includeSessions?: boolean;
  sessionIds?: readonly string[];
}

export function getCopilotUsageQueryOptions(
  scope?: CopilotUsageQueryScope,
  options?: { refresh?: boolean },
) {
  return queryOptions({
    queryKey: queryKeys.copilotUsage(scope),
    queryFn: ({ signal }) => fetchCopilotUsage({
      refresh: options?.refresh,
      signal,
      taskId: scope?.taskId,
      includeSessions: scope?.includeSessions,
    }),
    staleTime: COPILOT_USAGE_STALE_TIME,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (
      query.state.data?.index.state === "scanning"
        ? COPILOT_USAGE_INDEX_POLL_INTERVAL
        : false
    ),
  });
}

export async function refreshCopilotUsageQuery(
  queryClient: QueryClient,
  scope?: CopilotUsageQueryScope,
) {
  const queryKey = queryKeys.copilotUsage(scope);
  await queryClient.cancelQueries({ queryKey }, { silent: true });
  return queryClient.fetchQuery({
    ...getCopilotUsageQueryOptions(scope, { refresh: true }),
    staleTime: 0,
  });
}

export function useCopilotUsageQuery(scope?: CopilotUsageQueryScope) {
  const queryClient = useQueryClient();
  const query = useQuery(getCopilotUsageQueryOptions(scope));

  const refresh = useCallback(async () => {
    return refreshCopilotUsageQuery(queryClient, scope);
  }, [queryClient, scope?.includeSessions, scope?.sessionIds, scope?.taskId]);

  return {
    ...query,
    refresh,
  };
}
