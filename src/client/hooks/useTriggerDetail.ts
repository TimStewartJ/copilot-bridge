import { useState, useCallback, useEffect } from "react";
import { useOverlayParam } from "./useOverlayParam";

export type TriggerSheetMode = "view" | "edit" | "create";

const CREATE_VALUE = "new";

/** The task trigger sheet's state, kept in the URL so Back closes it and a link reopens it. */
export function useTriggerDetail() {
  const { isOpen, value, open, close: overlayClose } = useOverlayParam("triggerDetail");
  const [editing, setEditing] = useState(false);

  const creating = isOpen && value === CREATE_VALUE;
  const triggerId = isOpen && value && !creating ? value : null;
  const mode: TriggerSheetMode = creating ? "create" : editing ? "edit" : "view";

  useEffect(() => {
    if (!isOpen) setEditing(false);
  }, [isOpen]);

  const openSheet = useCallback((id: string, initialMode: Exclude<TriggerSheetMode, "create"> = "view") => {
    setEditing(initialMode === "edit");
    open(id);
  }, [open]);

  const openForCreate = useCallback(() => {
    setEditing(false);
    open(CREATE_VALUE);
  }, [open]);

  /** After saving, show the trigger in place of the form. */
  const showSaved = useCallback((id: string) => {
    setEditing(false);
    open(id, { replace: true });
  }, [open]);

  const switchToEdit = useCallback(() => setEditing(true), []);
  const switchToView = useCallback(() => setEditing(false), []);

  const close = useCallback(() => {
    overlayClose();
    setEditing(false);
  }, [overlayClose]);

  return { isOpen: isOpen && Boolean(value), triggerId, mode, openSheet, openForCreate, showSaved, switchToEdit, switchToView, close };
}
