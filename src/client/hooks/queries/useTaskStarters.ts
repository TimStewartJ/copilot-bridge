import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dismissTaskStarter, fetchTaskStarters, markTaskStarterUsed, refreshTaskStarters } from "../../api";
import { queryKeys } from "../../queryClient";
import type { TaskStartersResponse } from "../../../shared/task-starters.js";

const REFRESHING_POLL_MS = 2_000;

export function useTaskStartersQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.taskStarters(taskId),
    queryFn: ({ signal }) => fetchTaskStarters(taskId, { signal }),
    // Helm's looks write suggestions in the background, so coming back to the panel checks again.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.refreshing ? REFRESHING_POLL_MS : false),
  });
}

export function useTaskStartersActions(taskId: string) {
  const queryClient = useQueryClient();
  const key = queryKeys.taskStarters(taskId);
  const removeLocally = (starterId: string) => {
    queryClient.setQueryData<TaskStartersResponse>(key, (current) => current && {
      ...current, starters: current.starters.filter((starter) => starter.id !== starterId),
    });
  };
  const refresh = useMutation({
    mutationFn: () => refreshTaskStarters(taskId),
    onSuccess: (data) => { queryClient.setQueryData(key, data); },
  });
  const dismiss = useMutation({
    mutationFn: (starterId: string) => dismissTaskStarter(taskId, starterId),
    onMutate: removeLocally,
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: key }); },
  });
  const markUsed = (starterId: string) => {
    removeLocally(starterId);
    void markTaskStarterUsed(taskId, starterId).catch(() => undefined)
      .finally(() => { void queryClient.invalidateQueries({ queryKey: key }); });
  };
  return { refresh, dismiss, markUsed };
}
