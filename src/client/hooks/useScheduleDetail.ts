import { useState, useCallback, useEffect } from "react";
import { useOverlayParam } from "./useOverlayParam";
import type { Schedule } from "../api";

export type ScheduleSheetMode = "view" | "edit" | "create";

/** Manages schedule detail sheet state via URL params. */
export function useScheduleDetail() {
  const { isOpen: overlayOpen, value, open, close: overlayClose } = useOverlayParam("scheduleDetail");
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [mode, setMode] = useState<ScheduleSheetMode>("view");
  const [createTaskId, setCreateTaskId] = useState<string | null>(null);

  const scheduleId = overlayOpen ? value : null;
  const isOpen = overlayOpen && !!scheduleId;

  // Clear local state when overlay closes
  useEffect(() => {
    if (!overlayOpen) {
      setSchedule(null);
      setMode("view");
      setCreateTaskId(null);
    }
  }, [overlayOpen]);

  const openSheet = useCallback(
    (sched: Schedule, initialMode: ScheduleSheetMode = "view") => {
      setSchedule(sched);
      setMode(initialMode);
      open(sched.id);
    },
    [open],
  );

  const openForCreate = useCallback(
    (taskId: string) => {
      setSchedule(null);
      setMode("create");
      setCreateTaskId(taskId);
      open("new");
    },
    [open],
  );

  const switchToEdit = useCallback(() => setMode("edit"), []);
  const switchToView = useCallback(() => setMode("view"), []);

  const close = useCallback(() => {
    overlayClose();
    setSchedule(null);
    setMode("view");
    setCreateTaskId(null);
  }, [overlayClose]);

  return { isOpen, scheduleId, schedule, mode, createTaskId, openSheet, openForCreate, switchToEdit, switchToView, close };
}
