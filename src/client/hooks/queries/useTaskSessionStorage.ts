import { useQuery } from "@tanstack/react-query";
import { fetchTaskSessionStorage } from "../../api";
import { queryKeys } from "../../queryClient";

export function useTaskSessionStorageQuery(
  taskId: string | undefined,
  sessionLinksRevision: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: taskId ? queryKeys.taskSessionStorage(taskId, sessionLinksRevision) : ["task", null, "session-storage"],
    queryFn: ({ signal }) => fetchTaskSessionStorage(taskId!, { signal }),
    enabled: !!taskId && enabled,
    refetchOnWindowFocus: false,
  });
}
