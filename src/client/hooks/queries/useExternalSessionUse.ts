import { useQuery } from "@tanstack/react-query";
import { fetchExternalSessionUse } from "../../api";
import { queryKeys } from "../../queryClient";

export function useExternalSessionUseQuery(sessionIds: readonly string[]) {
  return useQuery({
    queryKey: queryKeys.externalSessionUse(sessionIds),
    queryFn: ({ signal }) => fetchExternalSessionUse(sessionIds, { signal }),
    enabled: sessionIds.length > 0,
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
