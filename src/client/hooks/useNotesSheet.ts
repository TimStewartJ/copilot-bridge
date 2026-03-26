import { useState, useCallback, useEffect } from "react";

/** Manages notes sheet open/close/edit state, resetting on task change. */
export function useNotesSheet(taskId: string | undefined) {
  const [notesSheetOpen, setNotesSheetOpen] = useState(false);
  const [notesStartEdit, setNotesStartEdit] = useState(false);

  // Reset when task changes
  useEffect(() => {
    setNotesSheetOpen(false);
    setNotesStartEdit(false);
  }, [taskId]);

  const openToView = useCallback(() => {
    setNotesStartEdit(false);
    setNotesSheetOpen(true);
  }, []);

  const openToEdit = useCallback(() => {
    setNotesStartEdit(true);
    setNotesSheetOpen(true);
  }, []);

  const close = useCallback(() => {
    setNotesSheetOpen(false);
    setNotesStartEdit(false);
  }, []);

  return { notesSheetOpen, notesStartEdit, openToView, openToEdit, close };
}
