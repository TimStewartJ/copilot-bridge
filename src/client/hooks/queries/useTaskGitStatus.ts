import { useQuery } from "@tanstack/react-query";
import { fetchTaskGitStatus } from "../../api";
import { queryKeys } from "../../queryClient";

export const TASK_GIT_STATUS_REFETCH_INTERVAL_MS = 60_000;

export function useTaskGitStatusQuery(taskId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.taskGitStatus(taskId!),
    queryFn: ({ signal }) => fetchTaskGitStatus(taskId!, { signal }),
    enabled: !!taskId && enabled,
    staleTime: TASK_GIT_STATUS_REFETCH_INTERVAL_MS,
    refetchInterval: TASK_GIT_STATUS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
}
