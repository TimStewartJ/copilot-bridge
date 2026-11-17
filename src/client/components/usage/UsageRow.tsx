import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DS, cx } from "../../design/tokens";

/** Needs an `@container/usage-models` parent: figures sit beside the name, under it if narrow. */
export default function UsageRow({ name, figures, bodyClassName, children }: {
  name: ReactNode;
  figures: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <details className={DS.details.root}>
      <summary className={cx(DS.usage.rowSummary, DS.focus)}>
        <ChevronRight size={13} aria-hidden="true" className={DS.details.chevron} />
        <span className="min-w-0 flex-1 break-words font-medium text-text-primary">{name}</span>
        <span className={DS.usage.figures}>{figures}</span>
      </summary>
      <div className={cx(DS.rail, bodyClassName)}>{children}</div>
    </details>
  );
}
