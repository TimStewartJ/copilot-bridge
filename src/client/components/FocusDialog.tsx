import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { useModalDialog } from "./shared/useModalDialog";

interface FocusDialogProps {
  title: string;
  description?: string;
  closeLabel?: string;
  pending: boolean;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary';

function focusTargets(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.tabIndex < 0) return false;
    for (let parent: Element | null = element; parent && parent !== root; parent = parent.parentElement) {
      if (parent.getAttribute("hidden") !== null || parent.getAttribute("inert") !== null || parent.getAttribute("aria-hidden") === "true") return false;
      if (parent.tagName === "DETAILS" && parent.getAttribute("open") === null) {
        const summary = Array.from(parent.children).find((child) => child.tagName === "SUMMARY");
        if (!summary?.contains(element)) return false;
      }
    }
    return true;
  });
}

export default function FocusDialog({ title, description, closeLabel = "Close dialog", pending, onClose, initialFocusRef, children }: FocusDialogProps) {
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose, dismissible: !pending });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const field = ref.current && focusTargets(ref.current).find((element) => ["TEXTAREA", "INPUT", "SELECT"].includes(element.tagName));
    (initialFocusRef?.current ?? field ?? ref.current)?.focus();
    return () => { if (previous && "focus" in previous && typeof previous.focus === "function") previous.focus(); };
  }, []);
  useEffect(() => {
    if (pending) ref.current?.focus();
  }, [pending]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-3 py-4 sm:px-4"
      onMouseDown={(event) => { if (!pending && event.target === event.currentTarget) onClose(); }}
    >
      <div
        {...dialogProps}
        ref={ref}
        tabIndex={-1}
        aria-describedby={description ? `${titleId}-description` : undefined}
        aria-busy={pending || undefined}
        className="max-h-[90dvh] w-full min-w-0 max-w-2xl overflow-y-auto rounded-2xl border border-border bg-bg-primary p-4 shadow-2xl sm:p-5"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = ref.current ? focusTargets(ref.current) : [];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first) { event.preventDefault(); ref.current?.focus(); }
          else if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
          }
        }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-lg font-semibold text-text-primary">{title}</h2>
            {description && <p id={`${titleId}-description`} className="mt-2 text-sm text-text-muted">{description}</p>}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            disabled={pending}
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent"
          ><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
