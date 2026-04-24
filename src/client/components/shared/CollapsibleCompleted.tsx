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
        onClick={() => setCollapsed((c) => !c)}
        className={`flex items-center gap-1 px-3 py-1 text-[10px] text-text-faint hover:text-text-muted transition-colors w-full ${className ?? ""}`}
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
