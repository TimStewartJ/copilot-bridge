import { useCallback, useEffect } from "react";
import { useOverlayParam } from "./useOverlayParam";

/** Manages notes sheet open/close/edit state via URL params, resetting on task change. */
export function useNotesSheet(taskId: string | undefined) {
  const { isOpen: notesSheetOpen, value, open, close: overlayClose } = useOverlayParam("sheet");

  // The sheet is open when ?sheet=notes or ?sheet=notes-edit
  const isOpen = notesSheetOpen && (value === "notes" || value === "notes-edit");
  const notesStartEdit = value === "notes-edit";

  // Reset when task changes
  useEffect(() => {
    if (isOpen) overlayClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const openToView = useCallback(() => {
    open("notes");
  }, [open]);

  const openToEdit = useCallback(() => {
    open("notes-edit");
  }, [open]);

  const close = useCallback(() => {
    overlayClose();
  }, [overlayClose]);

  return { notesSheetOpen: isOpen, notesStartEdit, openToView, openToEdit, close };
}
