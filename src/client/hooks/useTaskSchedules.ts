import { useState, useCallback } from "react";
import type { Schedule } from "../api";
import { useTaskSchedulesQuery, useTriggerScheduleMutation, useToggleScheduleMutation, useDeleteScheduleMutation } from "./queries/useSchedules";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryClient";
import { useOverlayParam } from "./useOverlayParam";

/** Manages schedule CRUD for a single task. */
export function useTaskSchedules(taskId: string | undefined, _scheduleVersion?: number) {
  const { data: schedules = [] } = useTaskSchedulesQuery(taskId);
  const queryClient = useQueryClient();
  const triggerMutation = useTriggerScheduleMutation(taskId);
  const toggleMutation = useToggleScheduleMutation(taskId);
  const removeMutation = useDeleteScheduleMutation(taskId);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const overlay = useOverlayParam("modal");
  const scheduleEditorOpen = overlay.isOpen && (overlay.value === "schedule" || overlay.value?.startsWith("schedule:"));

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

  const openEditor = useCallback((schedule?: Schedule) => {
    setEditingSchedule(schedule ?? null);
    overlay.open(schedule ? `schedule:${schedule.id}` : "schedule");
  }, [overlay]);

  const closeEditor = useCallback(() => {
    overlay.close();
    setEditingSchedule(null);
  }, [overlay]);

  const onSaved = useCallback(() => {
    closeEditor();
    reload();
  }, [closeEditor, reload]);

  return {
    schedules,
    scheduleEditorOpen,
    editingSchedule,
    reload,
    trigger,
    toggle,
    remove,
    openEditor,
    closeEditor,
    onSaved,
  };
}
