import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { useModalDialog } from "../components/shared/useModalDialog";
import { IconButton } from "./primitives";
import { DS, cx } from "./tokens";

interface DialogProps {
  title: string;
  description?: string;
  closeLabel?: string;
  pending: boolean;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: "default" | "wide";
  contained?: boolean;
  children: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary';

function focusTargets(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.tabIndex < 0) return false;
    for (let parent: Element | null = element; parent && parent !== root; parent = parent.parentElement) {
      if (parent.getAttribute("hidden") !== null || parent.getAttribute("inert") !== null || parent.getAttribute("aria-hidden") === "true") return false;
      if (parent.tagName === "FIELDSET" && parent.getAttribute("disabled") !== null) return false;
      if (parent.tagName === "DETAILS" && parent.getAttribute("open") === null) {
        const summary = Array.from(parent.children).find((child) => child.tagName === "SUMMARY");
        if (!summary?.contains(element)) return false;
      }
    }
    return true;
  });
}

/** Shared focused reading/form overlay, with keyboard containment and focus restoration. */
export default function Dialog({ title, description, closeLabel = "Close dialog", pending, onClose, initialFocusRef, size = "default", contained = false, children }: DialogProps) {
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
      className={DS.surface.scrim}
      onMouseDown={(event) => { if (!pending && event.target === event.currentTarget) onClose(); }}
    >
      <div
        {...dialogProps}
        ref={ref}
        tabIndex={-1}
        aria-describedby={description ? `${titleId}-description` : undefined}
        aria-busy={pending || undefined}
        className={cx(
          DS.surface.dialog,
          "w-full min-w-0",
          size === "wide" ? "max-w-3xl" : "max-w-2xl",
          contained ? "mt-[min(6dvh,3rem)] flex max-h-[min(82dvh,52rem)] flex-col self-start overflow-hidden" : "max-h-[90dvh] overflow-y-auto p-4 sm:p-5",
        )}
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
        <div className={cx("flex shrink-0 items-start justify-between gap-3", contained ? "px-4 pb-2 pt-4 sm:px-5" : "mb-4")}>
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-lg font-semibold text-text-primary">{title}</h2>
            {description && <p id={`${titleId}-description`} className="mt-2 text-sm text-text-muted">{description}</p>}
          </div>
          <IconButton label={closeLabel} disabled={pending} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
