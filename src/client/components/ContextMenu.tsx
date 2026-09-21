import { useEffect, useRef, useCallback, useState, useLayoutEffect, type ReactNode } from "react";
import { DS, cx } from "../design/tokens";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuProps {
  position: ContextMenuPosition;
  onClose: () => void;
  children: React.ReactNode;
}

const VIEWPORT_PADDING = 8;

export default function ContextMenu({ position, onClose, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [adjusted, setAdjusted] = useState<{ top: number; left: number } | null>(null);

  const stableClose = useCallback(() => onClose(), [onClose]);

  // Measure actual menu size after render and clamp to viewport
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = position.y;
    let left = position.x;

    // Flip up if overflowing bottom
    if (top + rect.height > vh - VIEWPORT_PADDING) {
      top = Math.max(VIEWPORT_PADDING, position.y - rect.height);
    }
    // Flip left if overflowing right
    if (left + rect.width > vw - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, vw - rect.width - VIEWPORT_PADDING);
    }

    setAdjusted({ top, left });
  }, [position.x, position.y]);

  useEffect(() => {
    const dismiss = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) stableClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") stableClose();
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("touchstart", dismiss);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("touchstart", dismiss);
      document.removeEventListener("keydown", esc);
    };
  }, [stableClose]);

  return (
    <div
      ref={ref}
      className={cx(DS.surface.floating, "fixed z-50 min-w-[180px] max-w-[calc(100vw-16px)] select-none cursor-default py-1 text-sm animate-ctx-menu-in")}
      style={{
        top: adjusted?.top ?? position.y,
        left: adjusted?.left ?? position.x,
        // Hide until measured to prevent flash at wrong position
        visibility: adjusted ? "visible" : "hidden",
      }}
    >
      {children}
    </div>
  );
}

export function CtxItem({
  icon,
  label,
  onClick,
  className = "",
  disabled,
  title,
}: {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [tapped, setTapped] = useState(false);

  const handleClick = () => {
    setTapped(true);
    // Call synchronously to preserve user-gesture context (required for
    // showPicker() / date inputs on mobile browsers).
    onClick();
  };

  return (
    <button
      type="button"
      className={cx(DS.menu.item, tapped && DS.menu.selected, disabled && "pointer-events-none opacity-40", className)}
      onClick={handleClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      {label}
    </button>
  );
}

export function CtxDivider() {
  return <div className={DS.menu.divider} />;
}
