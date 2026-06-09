import { useQuery } from "@tanstack/react-query";
import { fetchModelClientInfo } from "../../api";
import { queryKeys } from "../../queryClient";

export function useModelClientInfoQuery() {
  return useQuery({
    queryKey: queryKeys.modelClientInfo,
    queryFn: fetchModelClientInfo,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
