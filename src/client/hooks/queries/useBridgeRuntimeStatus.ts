import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchBridgeRuntimeStatus,
  restartBridge,
} from "../../bridge-management-api";
import { queryKeys } from "../../queryClient";

export const BRIDGE_RUNTIME_REFETCH_MS = 2_000;

export function useBridgeRuntimeStatusQuery() {
  return useQuery({
    queryKey: queryKeys.bridgeRuntimeStatus,
    queryFn: ({ signal }) => fetchBridgeRuntimeStatus({ signal }),
    refetchInterval: BRIDGE_RUNTIME_REFETCH_MS,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
}

export function useRestartBridgeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restartBridge,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bridgeRuntimeStatus });
      void queryClient.invalidateQueries({ queryKey: queryKeys.restartStatus });
    },
  });
}
