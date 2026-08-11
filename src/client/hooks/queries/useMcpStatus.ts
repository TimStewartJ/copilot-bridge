import { useQuery } from "@tanstack/react-query";
import { fetchMcpStatus } from "../../api";
import { queryKeys } from "../../queryClient";

export function useMcpStatusQuery(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.mcpStatus(sessionId ?? ""),
    queryFn: ({ signal }) => fetchMcpStatus(sessionId!, { signal }),
    enabled: Boolean(sessionId),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}
