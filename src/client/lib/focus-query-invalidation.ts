import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryClient";

export async function invalidateFocusMutationQueries(queryClient: QueryClient, actions = false): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.focusRoot }),
    ...(actions ? [
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard, exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.openChecklistItems }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "task"
          && (query.queryKey.length === 2 || query.queryKey[2] === "checklist-items"),
      }),
    ] : []),
  ]);
}

export async function invalidateFocusProtectionQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.focusRoot }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard, exact: true }),
    queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === "schedule"
        || (query.queryKey[0] === "task" && (query.queryKey.length === 2 || query.queryKey[2] === "schedules")),
    }),
  ]);
}
