import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

interface CollapsibleCompletedProps {
  count: number;
  children: ReactNode;
  /** Label text after the count (default: "completed") */
  label?: string;
  /** Extra classes on the toggle button text */
  className?: string;
  /** Forces the completed list open, while still allowing user toggles afterward */
  forceOpen?: boolean;
}

export default function CollapsibleCompleted({
  count,
  children,
  label = "completed",
  className,
  forceOpen = false,
}: CollapsibleCompletedProps) {
  const [collapsed, setCollapsed] = useState(!forceOpen);

  useEffect(() => {
    if (forceOpen) {
      setCollapsed(false);
    }
  }, [forceOpen]);

  if (count === 0) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        className={`flex min-h-10 items-center gap-1 px-3 py-1 text-[11px] text-text-faint hover:text-text-muted transition-colors w-full md:min-h-0 ${className ?? ""}`}
      >
        <ChevronRight
          size={10}
          className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
        <span>{count} {label}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}
