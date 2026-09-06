import { useState } from "react";
import { ApiError, fetchFocusLaunchReceiptById, type FocusObject } from "../api";
import { useFocusLaunchReceiptsQuery } from "../hooks/queries/useFocus";
import FocusCard from "./FocusCard";
import { FocusInteractionProvider, useFocusInteractions, type FocusInteractionProps } from "./FocusInteractions";
import { UI } from "./shared/design-system";

interface FocusItemCardProps extends FocusInteractionProps {
  object: FocusObject;
  compact?: boolean;
  readOnly?: boolean;
}

function ConnectedFocusItem({ object, compact = false, readOnly = false }: FocusItemCardProps) {
  const interactions = useFocusInteractions()!;
  const [expanded, setExpanded] = useState(!compact);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const receipts = useFocusLaunchReceiptsQuery(object, expanded);
  const openSession = async (id: string) => {
    setNavigationError(null);
    try {
      let receipt = receipts.data?.find((candidate) => candidate.sessionId === id);
      if (!receipt) {
        try {
          receipt = await fetchFocusLaunchReceiptById(id);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      }
      if (receipt && receipt.sessionId !== id) throw new Error("The receipt does not confirm this session yet.");
      // A source's task is not the session destination, including after a new
      // episode. Legacy sessions without a receipt can still open globally.
      interactions.onSelectSession(id, receipt?.taskId ?? undefined);
    } catch (error) {
      setNavigationError(`Could not verify session destination: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return <div>
    {navigationError && <p role="alert" className="mb-2 text-xs text-error">{navigationError}</p>}
    <FocusCard
      card={object} pending={interactions.pending} expanded={expanded} readOnly={readOnly}
      onToggleExpanded={compact ? () => setExpanded((value) => !value) : undefined}
      onSelectTask={interactions.onSelectTask}
      onSelectSession={(id) => void openSession(id)}
      onAction={(item) => interactions.launch(item, "launch_prompt")}
      onChat={(item) => interactions.launch(item, "discussion")}
      onLifecycle={interactions.lifecycle} onPromote={interactions.promote} onDelete={interactions.remove}
      onInspectHistory={interactions.onInspectHistory} snapshot={interactions.snapshot} nowMs={interactions.nowMs}
    />
    {expanded && receipts.error && <p role="alert" className="mt-2 text-xs text-error">Saved launch receipts unavailable: {receipts.error.message}
      <button type="button" className="ml-2 min-h-11 underline" onClick={() => void receipts.refetch()}>Retry launch receipts</button>
    </p>}
    {expanded && receipts.data?.map((receipt) => <div key={receipt.id} className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-xs text-text-muted">
      <span>{receipt.source === "discussion" ? "Discussion" : "Prompt launch"}: {receipt.status}. Source resolution is separate.</span>
      {receipt.sessionId && <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`}
        onClick={() => interactions.onSelectSession(receipt.sessionId!, receipt.taskId ?? undefined)}>
        {receipt.source === "discussion" ? "Open discussion session" : "Open launch session"}
      </button>}
      {!readOnly && <button type="button" className={`${UI.button.secondary} min-h-11 text-xs`} onClick={() => interactions.launch(object, receipt.source)}>Review launch receipt</button>}
    </div>)}
  </div>;
}

export default function FocusItemCard(props: FocusItemCardProps) {
  const interactions = useFocusInteractions();
  return interactions ? <ConnectedFocusItem {...props} />
    : <FocusInteractionProvider {...props}><ConnectedFocusItem {...props} /></FocusInteractionProvider>;
}
