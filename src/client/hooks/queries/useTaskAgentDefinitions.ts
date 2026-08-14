import { useQuery } from "@tanstack/react-query";
import { fetchTaskAgentDefinitions } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTaskAgentDefinitionsQuery(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.taskAgentDefinitions(taskId!),
    queryFn: () => fetchTaskAgentDefinitions(taskId!),
    enabled: Boolean(taskId),
  });
}
