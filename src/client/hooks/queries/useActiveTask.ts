import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTask, type Task } from "../../api";
import { queryKeys } from "../../queryClient";

export function useActiveTask(
  activeTaskId: string | null,
  tasks: Task[],
  tasksSettled: boolean,
) {
  const listTask = useMemo(
    () => activeTaskId ? tasks.find((task) => task.id === activeTaskId) : undefined,
    [activeTaskId, tasks],
  );
  const detailQuery = useQuery({
    queryKey: queryKeys.task(activeTaskId ?? ""),
    queryFn: () => fetchTask(activeTaskId!),
    enabled: Boolean(activeTaskId && tasksSettled && !listTask),
    retry: false,
  });
  const task = listTask ?? detailQuery.data ?? null;
  return {
    task,
    taskNotFound: Boolean(activeTaskId && !listTask && detailQuery.isError),
  };
}
