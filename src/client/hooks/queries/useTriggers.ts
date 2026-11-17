import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelTrigger,
  deleteTrigger,
  fetchSessionTriggers,
  fetchTaskTriggers,
  fetchTriggerChats,
  reactivateTrigger,
  runTrigger,
  updateTrigger,
} from "../../api";
import { queryKeys } from "../../queryClient";

export const TRIGGER_CHATS_PAGE_SIZE = 20;

export type TriggerAction = "run" | "pause" | "resume" | "cancel" | "reactivate" | "delete";

export function useSessionTriggersQuery(sessionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sessionTriggers(sessionId ?? ""),
    queryFn: ({ signal }) => fetchSessionTriggers(sessionId!, signal),
    enabled: !!sessionId,
  });
}

export function useTaskTriggersQuery(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.taskTriggers(taskId ?? ""),
    queryFn: ({ signal }) => fetchTaskTriggers(taskId!, signal),
    enabled: !!taskId,
  });
}

export function useTriggerChatsQuery(triggerId: string | undefined) {
  return useInfiniteQuery({
    queryKey: queryKeys.triggerChats(triggerId ?? ""),
    queryFn: ({ pageParam }) => fetchTriggerChats(triggerId!, {
      limit: TRIGGER_CHATS_PAGE_SIZE,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      if (lastPage.sessions.length === 0) return undefined;
      const nextOffset = lastPage.offset + lastPage.sessions.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    enabled: !!triggerId,
  });
}

function performTriggerAction(action: TriggerAction, id: string): Promise<unknown> {
  switch (action) {
    case "run": return runTrigger(id);
    case "pause": return updateTrigger(id, { active: false });
    case "resume": return updateTrigger(id, { active: true });
    case "cancel": return cancelTrigger(id);
    case "reactivate": return reactivateTrigger(id);
    case "delete": return deleteTrigger(id);
  }
}

/** Act on a trigger, then refresh every trigger list and the chats. */
export function useTriggerActionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id }: { action: TriggerAction; id: string }) => performTriggerAction(action, id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggersRoot });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}
