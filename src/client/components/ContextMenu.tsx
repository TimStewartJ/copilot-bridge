import { useEffect, useRef, useCallback } from "react";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuProps {
  position: ContextMenuPosition;
  onClose: () => void;
  children: React.ReactNode;
}

export default function ContextMenu({ position, onClose, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  const stableClose = useCallback(() => onClose(), [onClose]);

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
      className="fixed z-50 min-w-[180px] max-w-[calc(100vw-16px)] bg-bg-secondary border border-border rounded-lg shadow-lg py-1 text-sm animate-ctx-menu-in"
      style={{
        top: Math.min(position.y, window.innerHeight - 240),
        left: Math.min(position.x, window.innerWidth - 196),
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
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`w-full px-3 py-1.5 text-left hover:bg-bg-hover flex items-center gap-2 transition-colors ${
        disabled ? "opacity-40 pointer-events-none" : ""
      } ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      {label}
    </button>
  );
}

export function CtxDivider() {
  return <div className="border-t border-border my-1" />;
}
