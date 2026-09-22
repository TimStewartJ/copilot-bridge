import { queryOptions, useQuery } from "@tanstack/react-query";
import { fetchMcpStatusSnapshot } from "../../api";
import { queryKeys } from "../../queryClient";

export function getMcpStatusQueryOptions(sessionId: string | null) {
  return queryOptions({
    queryKey: queryKeys.mcpStatus(sessionId ?? ""),
    queryFn: ({ signal }) => fetchMcpStatusSnapshot(sessionId!, { signal }),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
    // Connections can change after tool initialization. Keep observing both independently.
    refetchInterval: (query) => query.state.data?.toolReadiness?.state === "initializing" ? 2_000 : 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useMcpStatusSnapshotQuery(sessionId: string | null) {
  return useQuery(getMcpStatusQueryOptions(sessionId));
}

export function useMcpStatusQuery(sessionId: string | null) {
  return useQuery({
    ...getMcpStatusQueryOptions(sessionId),
    select: (snapshot) => snapshot.servers,
  });
}
