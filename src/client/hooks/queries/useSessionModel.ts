import { useQuery } from "@tanstack/react-query";
import { fetchSessionModelState } from "../../api";
import { queryClient, queryKeys } from "../../queryClient";

export function useSessionModelQuery(
  sessionId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const enabled = Boolean(sessionId) && (options?.enabled ?? true);
  return useQuery({
    queryKey: queryKeys.sessionModel(sessionId ?? ""),
    queryFn: () => fetchSessionModelState(sessionId!),
    enabled,
  }, queryClient);
}
