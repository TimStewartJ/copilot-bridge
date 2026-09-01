import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchWorkMap } from "../../api";
import { queryKeys } from "../../queryClient";

export function useWorkMapQuery(enabled: boolean, includeArchived: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.workMap(includeArchived),
    queryFn: () => fetchWorkMap({ includeArchived }),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const refresh = useMutation({
    mutationFn: () => fetchWorkMap({ forceRefresh: true, includeArchived }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.workMap(includeArchived), data);
    },
  });

  return {
    ...query,
    refresh: refresh.mutateAsync,
    isRefreshing: refresh.isPending || query.isFetching,
  };
}
