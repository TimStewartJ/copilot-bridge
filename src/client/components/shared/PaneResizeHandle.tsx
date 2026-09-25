import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DS, cx } from "../../design/tokens";

interface PaneWidthOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

function clampWidth(width: number, { minWidth, maxWidth }: Pick<PaneWidthOptions, "minWidth" | "maxWidth">): number {
  return Math.round(Math.min(maxWidth, Math.max(minWidth, width)));
}

function readStoredWidth(options: PaneWidthOptions): number {
  try {
    const stored = Number(localStorage.getItem(options.storageKey));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored, options) : options.defaultWidth;
  } catch {
    return options.defaultWidth;
  }
}

/** The window's width, following resizes. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/** A side pane's width in pixels, kept between visits. */
export function usePaneWidth(options: PaneWidthOptions) {
  const [width, setWidthState] = useState(() => readStoredWidth(options));
  const { storageKey, minWidth, maxWidth } = options;
  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next, { minWidth, maxWidth });
    setWidthState(clamped);
    try {
      localStorage.setItem(storageKey, String(clamped));
    } catch {
      // The width still applies for this visit.
    }
  }, [maxWidth, minWidth, storageKey]);
  return { width, setWidth, minWidth, maxWidth, defaultWidth: options.defaultWidth };
}

const KEYBOARD_STEP = 16;

/**
 * The edge of a pane that can be dragged to resize it. It is a separator to assistive technology,
 * moves with the arrow keys, and returns to the default width on double-click.
 */
export default function PaneResizeHandle({
  label,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  onResize,
  className,
}: {
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  onResize: (width: number) => void;
  className?: string;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    onResize(drag.startWidth + event.clientX - drag.startX);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") onResize(width - KEYBOARD_STEP);
    else if (event.key === "ArrowRight") onResize(width + KEYBOARD_STEP);
    else if (event.key === "Home") onResize(minWidth);
    else if (event.key === "End") onResize(maxWidth);
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(defaultWidth)}
      onKeyDown={handleKeyDown}
      className={cx(
        "group/resize absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize touch-none rounded-sm",
        DS.focus,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          dragging ? "bg-text-faint" : "bg-transparent group-hover/resize:bg-border",
        )}
      />
    </div>
  );
}
