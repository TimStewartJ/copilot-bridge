import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchSchedules,
  patchSchedule,
  deleteSchedule,
  triggerSchedule,
  type Schedule,
} from "../../api";
import { queryKeys } from "../../queryClient";

export function useTaskSchedulesQuery(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.taskSchedules(taskId!),
    queryFn: () => fetchSchedules(taskId!),
    enabled: !!taskId,
  });
}

export function useTriggerScheduleMutation(taskId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => triggerSchedule(scheduleId),
    onSettled: () => {
      if (taskId) queryClient.invalidateQueries({ queryKey: queryKeys.taskSchedules(taskId) });
    },
  });
}

export function useToggleScheduleMutation(taskId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (schedule: Schedule) =>
      patchSchedule(schedule.id, { enabled: !schedule.enabled }),
    onSuccess: (updated) => {
      if (!taskId) return;
      queryClient.setQueryData<Schedule[]>(
        queryKeys.taskSchedules(taskId),
        (old) => old?.map((s) => (s.id === updated.id ? updated : s)),
      );
    },
  });
}

export function useDeleteScheduleMutation(taskId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => deleteSchedule(scheduleId),
    onSuccess: (_data, scheduleId) => {
      if (!taskId) return;
      queryClient.setQueryData<Schedule[]>(
        queryKeys.taskSchedules(taskId),
        (old) => old?.filter((s) => s.id !== scheduleId),
      );
    },
  });
}
