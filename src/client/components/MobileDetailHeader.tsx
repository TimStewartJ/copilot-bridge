import { ChevronLeft } from "lucide-react";

interface MobileDetailHeaderProps {
  onBack: () => void;
  upLabel?: string;
  title?: string;
  metadata?: string;
}

export function MobileDetailHeader({
  onBack,
  upLabel = "Back",
  title,
  metadata,
}: MobileDetailHeaderProps) {
  const hasDetailCopy = Boolean(title || metadata);

  return (
    <header className="shrink-0 border-b border-border bg-bg-secondary px-4 py-2.5 md:hidden">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex shrink-0 items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text-primary"
          aria-label={upLabel === "Back" ? "Back" : `Back to ${upLabel}`}
        >
          <ChevronLeft size={16} strokeWidth={2} />
          <span>{upLabel}</span>
        </button>

        {hasDetailCopy && (
          <div className="min-w-0 flex-1">
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
      </div>
    </header>
  );
}
