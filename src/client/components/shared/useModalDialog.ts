import { useEffect, useId, useRef } from "react";

export interface ModalDialogOptions {
  /** Called when the modal should close, e.g. when Escape is pressed. */
  onDismiss: () => void;
  /** The parent's render condition, so a conditional dialog can still call this hook always. */
  open?: boolean;
  /** False while it must not close (e.g. submitting); it still eats Escape for overlays below. */
  dismissible?: boolean;
  /** Accessible name for overlays without a visible heading to reference. */
  label?: string;
}

export interface ModalDialogAriaProps {
  role: "dialog";
  "aria-modal": true;
  "aria-labelledby"?: string;
  "aria-label"?: string;
}

export interface ModalDialog {
  /** Put this on the heading that names the dialog when no `label` is given. */
  titleId: string;
  /** Spread onto the element that visually contains the dialog. */
  dialogProps: ModalDialogAriaProps;
}

interface ModalStackEntry {
  onDismiss: () => void;
  dismissible: boolean;
}

// Modals register in mount order, so the most recently opened overlay is last.
const modalStack: ModalStackEntry[] = [];
let escapeListenerAttached = false;

function handleEscapeKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const topmost = modalStack[modalStack.length - 1];
  // Only the topmost dialog reacts; a non-dismissible one still eats Escape so none below closes.
  if (!topmost || !topmost.dismissible) return;
  topmost.onDismiss();
}

function pushModal(entry: ModalStackEntry) {
  modalStack.push(entry);
  if (escapeListenerAttached || typeof document === "undefined") return;
  document.addEventListener("keydown", handleEscapeKeyDown);
  escapeListenerAttached = true;
}

function removeModal(entry: ModalStackEntry) {
  const index = modalStack.lastIndexOf(entry);
  if (index >= 0) modalStack.splice(index, 1);
  if (modalStack.length > 0 || !escapeListenerAttached || typeof document === "undefined") return;
  document.removeEventListener("keydown", handleEscapeKeyDown);
  escapeListenerAttached = false;
}

/** Modal dialog semantics: role, aria-modal, a name, and Escape that closes only the topmost. */
export function useModalDialog({
  onDismiss,
  open = true,
  dismissible = true,
  label,
}: ModalDialogOptions): ModalDialog {
  const titleId = useId();
  const entryRef = useRef<ModalStackEntry | null>(null);
  entryRef.current ??= { onDismiss, dismissible };

  useEffect(() => {
    const entry = entryRef.current!;
    entry.onDismiss = onDismiss;
    entry.dismissible = dismissible;
  });

  useEffect(() => {
    if (!open) return;
    const entry = entryRef.current!;
    pushModal(entry);
    return () => removeModal(entry);
  }, [open]);

  return {
    titleId,
    dialogProps: label
      ? { role: "dialog", "aria-modal": true, "aria-label": label }
      : { role: "dialog", "aria-modal": true, "aria-labelledby": titleId },
  };
}
