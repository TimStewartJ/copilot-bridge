import type { QueryClient } from "@tanstack/react-query";
import type { Task } from "../api";
import { queryKeys } from "../queryClient";

export function updateTaskInQueryCaches(
  queryClient: QueryClient,
  taskId: string,
  update: (task: Task) => Task,
): void {
  queryClient.setQueryData<Task[]>(queryKeys.tasks, (current) =>
    current?.map((task) => task.id === taskId ? update(task) : task),
  );
  queryClient.setQueryData<Task>(queryKeys.task(taskId), (current) =>
    current ? update(current) : current,
  );
}

export function setTaskInQueryCaches(queryClient: QueryClient, task: Task): void {
  queryClient.setQueryData<Task[]>(queryKeys.tasks, (current) =>
    current?.map((candidate) => candidate.id === task.id ? task : candidate),
  );
  queryClient.setQueryData<Task>(queryKeys.task(task.id), task);
}
