import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TaskTriggers, TriggerView } from "../api";
import { queryKeys } from "../queryClient";
import { useTaskTriggersQuery, useTriggerActionMutation, type TriggerAction } from "./queries/useTriggers";

/** A task's triggers and the actions on them. */
export function useTaskTriggers(taskId: string | undefined) {
  const { data, isPending } = useTaskTriggersQuery(taskId);
  const queryClient = useQueryClient();
  const actionMutation = useTriggerActionMutation();

  const reload = useCallback(async () => {
    if (taskId) await queryClient.invalidateQueries({ queryKey: queryKeys.taskTriggers(taskId) });
  }, [taskId, queryClient]);

  /** Show a created or edited trigger at once, then refresh the list from the server. */
  const saved = useCallback((trigger: TriggerView) => {
    if (!taskId) return;
    queryClient.setQueryData<TaskTriggers>(queryKeys.taskTriggers(taskId), (current) => current && {
      ...current,
      triggers: current.triggers.some((item) => item.id === trigger.id)
        ? current.triggers.map((item) => item.id === trigger.id ? trigger : item)
        : [...current.triggers, trigger],
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskTriggers(taskId) });
  }, [taskId, queryClient]);

  const act = useCallback(async (action: TriggerAction, id: string) => {
    await actionMutation.mutateAsync({ action, id });
  }, [actionMutation]);

  return {
    triggers: data?.triggers ?? [],
    /** False until the first answer (or error) for this task arrives. */
    settled: !taskId || !isPending,
    reload,
    saved,
    act,
  };
}
