import { ChevronLeft } from "lucide-react";
import { DS, cx } from "../design/tokens";

interface MobileDetailHeaderProps {
  onBack: () => void;
  upLabel?: string;
  title?: string;
  metadata?: string;
}

/** The bar above a detail screen on a phone: the way back, and the name of what is open. */
export function MobileDetailHeader({
  onBack,
  upLabel = "Back",
  title,
  metadata,
}: MobileDetailHeaderProps) {
  const hasDetailCopy = Boolean(title || metadata);

  return (
    <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-2 md:hidden">
      <button
        type="button"
        onClick={onBack}
        className={cx("inline-flex h-10 shrink-0 items-center gap-1 rounded-lg pl-1 pr-2 text-sm text-text-muted transition-colors hover:text-text-primary", DS.focus)}
        aria-label={upLabel === "Back" ? "Back" : `Back to ${upLabel}`}
      >
        <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
        <span>{upLabel}</span>
      </button>

      {hasDetailCopy && (
        <div className="min-w-0 flex-1 pr-2">
          {title && (
            <div className="truncate text-sm font-medium text-text-primary">
              {title}
            </div>
          )}
          {metadata && (
            <div className="truncate text-xs text-text-muted">
              {metadata}
            </div>
          )}
        </div>
      )}
    </header>
  );
}