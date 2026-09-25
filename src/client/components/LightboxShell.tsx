import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Download, X } from "lucide-react";
import { DS, cx } from "../design/tokens";
import { useModalDialog } from "./shared/useModalDialog";

/**
 * The full-screen viewer for published diagrams, charts and interactive visuals. The page falls
 * away behind a blurred backdrop, a thin bar names what is open and holds its actions, and the
 * content takes the rest of the screen. Images use the gesture viewer in image-viewer.ts instead.
 */

/** Marks an element whose clicks close the viewer, so the empty space around content dismisses it. */
export const LIGHTBOX_BACKDROP_ATTR = "data-lightbox-backdrop";

interface LightboxShellProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

export function LightboxShell({ title, subtitle, actions, onClose, children }: LightboxShellProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target === event.currentTarget || target?.hasAttribute?.(LIGHTBOX_BACKDROP_ATTR)) onClose();
  };

  return (
    <div
      className={cx("fixed inset-0 z-50 flex flex-col bg-surface-canvas/95 backdrop-blur-md", DS.motion.reveal)}
      onClick={handleClick}
      {...dialogProps}
    >
      <div className="flex shrink-0 items-center gap-3 px-3 py-2 sm:px-5 sm:py-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-medium text-text-primary">{title}</h2>
          {subtitle && <p className="truncate text-xs tabular-nums text-text-faint">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className={cx(DS.button.base, DS.button.icon.md, DS.button.variant.ghost)}
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col" {...{ [LIGHTBOX_BACKDROP_ATTR]: "" }}>
        {children}
      </div>
    </div>
  );
}

/** A download link styled as the viewer's other actions. */
export function LightboxDownload({ href, fileName }: { href: string; fileName: string }) {
  return (
    <a
      href={href}
      download={fileName}
      className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
      aria-label={`Download ${fileName}`}
      title={`Download ${fileName}`}
    >
      <Download size={15} aria-hidden="true" />
      <span className="hidden sm:inline">Download</span>
    </a>
  );
}
