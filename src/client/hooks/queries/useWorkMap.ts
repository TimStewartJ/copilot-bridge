import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchWorkMap } from "../../api";
import { queryKeys } from "../../queryClient";

export function useWorkMapQuery(
  enabled: boolean,
  includeArchived: boolean,
  assignedToMe: boolean,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.workMap(includeArchived, assignedToMe),
    queryFn: () => fetchWorkMap({ includeArchived, assignedToMe }),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const refresh = useMutation({
    mutationFn: () => fetchWorkMap({ forceRefresh: true, includeArchived, assignedToMe }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.workMap(includeArchived, assignedToMe), data);
    },
  });

  return {
    ...query,
    refresh: refresh.mutateAsync,
    isRefreshing: refresh.isPending || query.isFetching,
  };
}
