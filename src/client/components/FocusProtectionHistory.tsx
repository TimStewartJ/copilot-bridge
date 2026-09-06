import { useState } from "react";
import { protectionTime } from "../focus-protection-helpers";
import { useFocusProtectionPagesQuery } from "../hooks/queries/useFocusProtection";
import { UI } from "./shared/design-system";

export default function FocusProtectionHistory() {
  const [open, setOpen] = useState(false);
  const query = useFocusProtectionPagesQuery(open);
  const windows = query.data?.pages.flatMap((page) => page.windows);
  return <details className="min-w-0 border-t border-border pt-2 text-xs [overflow-wrap:anywhere]" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="min-h-11 cursor-pointer py-3 font-medium text-text-secondary">Previous protection windows</summary>
    {open && <div className="min-w-0 space-y-3">
      {query.isPending && <p role="status">Loading protection history…</p>}
      {query.error && <div role="alert" className="space-y-2 text-warning">
        <p>Protection history is incomplete / unknown: {query.error.message}. Last loaded records are retained.</p>
        <button type="button" disabled={query.isFetching} className={`${UI.button.secondary} min-h-11 max-w-full`} onClick={() => void query.refetch()}>Retry protection history</button>
      </div>}
      {windows?.map((window) => <div key={window.id} className="min-w-0 space-y-1 rounded-lg border border-border p-3">
        <p className="font-medium">{window.reason} · {window.status}</p>
        <p>{protectionTime(window.startsAt, window.timezone)} – {protectionTime(window.endsAt, window.timezone)} ({window.timezone})</p>
        <p>Needs-input bypass {window.allowNeedsInput ? "allowed" : "off"}; authorized deadline bypass {window.allowAuthorizedDeadlineOverride ? "eligible Alerts only" : "off"}.</p>
      </div>)}
      {query.isSuccess && windows?.length === 0 && <p>No protection windows recorded.</p>}
      {query.hasNextPage && <button type="button" disabled={query.isFetching} className={`${UI.button.secondary} min-h-11 max-w-full`} onClick={() => void query.fetchNextPage()}>
        {query.isFetchingNextPage ? "Loading more…" : "Load more protection windows"}
      </button>}
    </div>}
  </details>;
}
