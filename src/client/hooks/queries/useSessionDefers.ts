import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelSessionDefer,
  fetchSessionDefers,
  reactivateSessionDefer,
} from "../../api";
import { queryKeys } from "../../queryClient";

function invalidateDeferredWork(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.sessionDefers(sessionId) });
  void queryClient.invalidateQueries({ queryKey: ["sessions"] });
}

export function useSessionDefersQuery(sessionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sessionDefers(sessionId ?? ""),
    queryFn: ({ signal }) => fetchSessionDefers(sessionId!, signal),
    enabled: !!sessionId,
  });
}

export function useCancelSessionDeferMutation(sessionId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deferId: string) => cancelSessionDefer(sessionId!, deferId),
    onSuccess: () => {
      if (sessionId) invalidateDeferredWork(queryClient, sessionId);
    },
  });
}

export function useReactivateSessionDeferMutation(sessionId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deferId: string) => reactivateSessionDefer(sessionId!, deferId),
    onSuccess: () => {
      if (sessionId) invalidateDeferredWork(queryClient, sessionId);
    },
  });
}
