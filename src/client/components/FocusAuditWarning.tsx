import { useState } from "react";
import type { FocusAttentionAudit } from "../api";
import { useFocusAuditPagesQuery } from "../hooks/queries/useFocus";
import { UI } from "./shared/design-system";

const CATEGORY = { false_positive: "Overpublished", missed_attention: "Missed attention", stale: "Stale evidence", misclassified: "Misclassified", leakage: "Leakage", notification: "Notification", coverage: "Coverage", other: "Other" };

export default function FocusAuditWarning({ exceptions, observedAt, onInspectHistory }: { exceptions: FocusAttentionAudit[]; observedAt?: string; onInspectHistory: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const query = useFocusAuditPagesQuery(expanded);
  const useSnapshot = Boolean(observedAt && (!query.data || Date.parse(observedAt) > query.dataUpdatedAt));
  const open = (useSnapshot ? exceptions : query.data?.pages.flat() ?? exceptions).filter((audit) => audit.status === "open");
  if (open.length === 0) return null;
  return <aside className="rounded-xl border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-warning">
    <button type="button" aria-expanded={expanded} className="min-h-11 text-left font-medium" onClick={() => setExpanded((value) => !value)}>
      Attention quality: {open.length} open audit exception{open.length === 1 ? "" : "s"}
    </button>
    {expanded && <div className="space-y-2 pb-2">
      <p>Exceptions flag missed or unnecessary attention, leakage, or coverage problems. They are not throughput scores.</p>
      {query.error && <p role="alert">Audit refresh failed: {query.error.message} <button type="button" className="min-h-11 underline" onClick={() => void query.refetch()}>Retry audits</button></p>}
      {open.map((audit) => <article key={audit.id} className="rounded-lg border border-warning/20 p-2 text-text-secondary">
        <p className="font-medium">{CATEGORY[audit.category]}: {audit.title}</p><p className="mt-1">{audit.notes}</p>
        {audit.objectId && <button type="button" className="min-h-11 text-accent underline" onClick={() => onInspectHistory(audit.objectId!)}>Inspect subject history</button>}
      </article>)}
      {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => void query.fetchNextPage()}>Load more exceptions</button>}
    </div>}
  </aside>;
}
