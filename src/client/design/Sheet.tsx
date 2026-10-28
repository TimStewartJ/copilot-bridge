import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModalDialog } from "../components/shared/useModalDialog";
import { IconButton } from "./primitives";
import { DS, cx } from "./tokens";

/**
 * A short list or menu opened over the page: a sheet from the bottom on a phone, so the page keeps
 * the screen, and a panel near the top on a desktop. It names itself, keeps focus inside while
 * open and gives focus back when it closes.
 */
export default function Sheet({ title, detail, closeLabel = "Close", onClose, bodyClassName = "px-5 pt-2", children }: {
  title: ReactNode;
  /** One quiet line under the title, such as a count or an age. */
  detail?: ReactNode;
  closeLabel?: string;
  onClose: () => void;
  /** Horizontal and top padding of the scrolling body; the bottom clears the phone's home indicator. */
  bodyClassName?: string;
  children: ReactNode;
}) {
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], summary, [tabindex]:not([tabindex="-1"])') ?? [],
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div {...dialogProps} ref={dialogRef} onKeyDown={keepFocusInside} className={DS.surface.compactSheet}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border py-2 pl-5 pr-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold text-text-primary">{title}</h2>
            {detail && <p className="truncate text-xs tabular-nums text-text-muted">{detail}</p>}
          </div>
          <IconButton ref={closeButtonRef} label={closeLabel} size="md" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className={cx("flex-1 overflow-y-auto overscroll-contain", bodyClassName)} style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
