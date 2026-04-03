import { useState, useEffect, useCallback } from "react";
import type { Schedule } from "../api";
import { fetchSchedules, patchSchedule, deleteSchedule, triggerSchedule } from "../api";

/** Manages schedule CRUD for a single task. */
export function useTaskSchedules(taskId: string | undefined, scheduleVersion?: number) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  const reload = useCallback(() => {
    if (taskId) {
      fetchSchedules(taskId).then(setSchedules).catch(() => setSchedules([]));
    } else {
      setSchedules([]);
    }
  }, [taskId]);

  useEffect(() => { reload(); }, [reload, scheduleVersion]);

  const trigger = useCallback(async (scheduleId: string) => {
    await triggerSchedule(scheduleId);
    reload();
  }, [reload]);

  const toggle = useCallback(async (schedule: Schedule) => {
    await patchSchedule(schedule.id, { enabled: !schedule.enabled });
    reload();
  }, [reload]);

  const remove = useCallback(async (scheduleId: string) => {
    await deleteSchedule(scheduleId);
    reload();
  }, [reload]);

  const openEditor = useCallback((schedule?: Schedule) => {
    setEditingSchedule(schedule ?? null);
    setScheduleEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => {
    setScheduleEditorOpen(false);
    setEditingSchedule(null);
  }, []);

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
