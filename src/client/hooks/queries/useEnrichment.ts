import { useQuery } from "@tanstack/react-query";
import { fetchEnrichedTask } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTaskEnrichmentQuery(
  taskId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.taskEnriched(taskId!),
    queryFn: () => fetchEnrichedTask(taskId!),
    enabled: !!taskId && enabled,
  });
}
