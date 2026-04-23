import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryClient";

export function invalidateSharedTaskChangeQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
  void queryClient.invalidateQueries({ queryKey: queryKeys.openTodos });
}

export function invalidateTaskScopedChangeQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  taskId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.taskTodos(taskId) });
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "task"
      && query.queryKey[1] === taskId
      && query.queryKey[2] === "enriched",
  });
}

export function invalidateTaskChangeQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  taskId?: string,
): void {
  invalidateSharedTaskChangeQueries(queryClient);
  if (!taskId) return;
  invalidateTaskScopedChangeQueries(queryClient, taskId);
}

export function createDeferredTaskChangeInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): {
  beginTaskMutation: () => void;
  endTaskMutation: () => void;
  handleTaskChange: (taskId?: string) => void;
} {
  let taskMutationsInFlight = 0;
  let hasPendingSharedInvalidation = false;
  const pendingTaskIds = new Set<string>();

  return {
    beginTaskMutation() {
      taskMutationsInFlight += 1;
    },
    endTaskMutation() {
      taskMutationsInFlight = Math.max(0, taskMutationsInFlight - 1);
      if (taskMutationsInFlight > 0) return;
      if (!hasPendingSharedInvalidation && pendingTaskIds.size === 0) return;

      invalidateSharedTaskChangeQueries(queryClient);
      for (const taskId of pendingTaskIds) {
        invalidateTaskScopedChangeQueries(queryClient, taskId);
      }
      hasPendingSharedInvalidation = false;
      pendingTaskIds.clear();
    },
    handleTaskChange(taskId?: string) {
      if (taskMutationsInFlight === 0) {
        invalidateTaskChangeQueries(queryClient, taskId);
        return;
      }

      hasPendingSharedInvalidation = true;
      if (taskId) pendingTaskIds.add(taskId);
    },
  };
}
