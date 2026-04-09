import { useCallback } from "react";
import type { Schedule } from "../api";
import { useTaskSchedulesQuery, useTriggerScheduleMutation, useToggleScheduleMutation, useDeleteScheduleMutation } from "./queries/useSchedules";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryClient";

/** Manages schedule CRUD for a single task. */
export function useTaskSchedules(taskId: string | undefined) {
  const { data: schedules = [] } = useTaskSchedulesQuery(taskId);
  const queryClient = useQueryClient();
  const triggerMutation = useTriggerScheduleMutation(taskId);
  const toggleMutation = useToggleScheduleMutation(taskId);
  const removeMutation = useDeleteScheduleMutation(taskId);

  const reload = useCallback(() => {
    if (taskId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskSchedules(taskId) });
    }
  }, [taskId, queryClient]);

  const trigger = useCallback(async (scheduleId: string) => {
    await triggerMutation.mutateAsync(scheduleId);
  }, [triggerMutation]);

  const toggle = useCallback(async (schedule: Schedule) => {
    await toggleMutation.mutateAsync(schedule);
  }, [toggleMutation]);

  const remove = useCallback(async (scheduleId: string) => {
    await removeMutation.mutateAsync(scheduleId);
  }, [removeMutation]);

  return {
    schedules,
    reload,
    trigger,
    toggle,
    remove,
  };
}
