import { useCallback, useEffect } from "react";
import { useOverlayParam } from "./useOverlayParam";

/**
 * Manages a task text sheet's open/close/edit state via the `sheet` URL param, resetting on task
 * change. `name` picks the sheet: `?sheet=<name>` views it and `?sheet=<name>-edit` edits it.
 */
export function useNotesSheet(taskId: string | undefined, name: "notes" | "instructions" | "history" = "notes") {
  const { isOpen: sheetParamOpen, value, open, close: overlayClose } = useOverlayParam("sheet");
  const editValue = `${name}-edit`;

  const isOpen = sheetParamOpen && (value === name || value === editValue);
  const notesStartEdit = value === editValue;

  // Reset when task changes
  useEffect(() => {
    if (isOpen) overlayClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const openToView = useCallback(() => {
    open(name);
  }, [open, name]);

  const openToEdit = useCallback(() => {
    open(editValue);
  }, [open, editValue]);

  const close = useCallback(() => {
    overlayClose();
  }, [overlayClose]);

  return { notesSheetOpen: isOpen, notesStartEdit, openToView, openToEdit, close };
}
