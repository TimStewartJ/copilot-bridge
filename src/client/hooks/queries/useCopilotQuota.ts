import { useCallback } from "react";
import { queryOptions, type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCopilotQuota } from "../../api";
import { queryKeys } from "../../queryClient";

// The live counter is a network round trip, so it is cached rather than
// refetched per render. It polls once a minute; Refresh forces a read.
const COPILOT_QUOTA_STALE_TIME = 60_000;
const COPILOT_QUOTA_POLL_INTERVAL = 60_000;

export function getCopilotQuotaQueryOptions(options?: { refresh?: boolean }) {
  return queryOptions({
    queryKey: queryKeys.copilotQuota,
    queryFn: ({ signal }) => fetchCopilotQuota({ refresh: options?.refresh, signal }),
    staleTime: COPILOT_QUOTA_STALE_TIME,
    refetchInterval: COPILOT_QUOTA_POLL_INTERVAL,
    refetchOnWindowFocus: false,
  });
}

export async function refreshCopilotQuotaQuery(queryClient: QueryClient) {
  await queryClient.cancelQueries({ queryKey: queryKeys.copilotQuota }, { silent: true });
  return queryClient.fetchQuery({
    ...getCopilotQuotaQueryOptions({ refresh: true }),
    staleTime: 0,
  });
}

export function useCopilotQuotaQuery() {
  const queryClient = useQueryClient();
  const query = useQuery(getCopilotQuotaQueryOptions());

  const refresh = useCallback(async () => {
    return refreshCopilotQuotaQuery(queryClient);
  }, [queryClient]);

  return {
    ...query,
    refresh,
  };
}
