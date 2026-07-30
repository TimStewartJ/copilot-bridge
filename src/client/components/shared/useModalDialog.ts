import { useEffect, useId, useRef } from "react";

export interface ModalDialogOptions {
  /** Called when the modal should close, e.g. when Escape is pressed. */
  onDismiss: () => void;
  /**
   * Whether the overlay is currently rendered. Pass the same condition the
   * parent uses to render the overlay so a conditionally rendered dialog can
   * still call this hook unconditionally.
   */
  open?: boolean;
  /**
   * Set to false while the dialog must not be dismissed (e.g. while
   * submitting). The dialog stays topmost and keeps swallowing Escape so an
   * overlay underneath it never closes instead.
   */
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
  // Only the topmost participating dialog reacts, and a non-dismissible one
  // still consumes Escape rather than letting the overlay beneath it close.
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

/**
 * Gives an overlay real modal dialog semantics: `role="dialog"`,
 * `aria-modal="true"`, an accessible name, and Escape-key dismissal that only
 * closes the topmost overlay when overlays stack.
 */
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
