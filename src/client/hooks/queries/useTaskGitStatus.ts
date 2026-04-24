import { useQuery } from "@tanstack/react-query";
import { fetchTaskGitStatus } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTaskGitStatusQuery(taskId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.taskGitStatus(taskId!),
    queryFn: ({ signal }) => fetchTaskGitStatus(taskId!, { signal }),
    enabled: !!taskId && enabled,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
