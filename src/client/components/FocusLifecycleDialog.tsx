import { useId, useRef, useState } from "react";
import type { FocusObject } from "../api";
import FocusDialog from "./FocusDialog";
import FocusEvidenceValidity from "./FocusEvidenceValidity";
import { UI } from "./shared/design-system";

export type FocusLifecycleIntent = "resolved" | "accepted_risk" | "dismissed" | "reactivate";
const INTENT_TEXT: Record<FocusLifecycleIntent, { title: string; explanation: string }> = {
  resolved: { title: "Resolve", explanation: "Record the basis and outcome. Linked Actions are not automatically completed." },
  accepted_risk: { title: "Accept risk", explanation: "Explicitly accept the remaining risk. This is not evidence that the condition was fixed." },
  dismissed: { title: "Dismiss", explanation: "Remove this episode from attention, without approving a proposal or resolving linked work." },
  reactivate: { title: "Reactivate as a new episode", explanation: "Explain the new occurrence or material change. Previous history and open Actions remain linked." },
};
const DISMISS_REASONS = [
  "Not relevant to me",
  "False positive",
  "Duplicate alert",
] as const;

interface FocusLifecycleDialogProps {
  object: FocusObject;
  intent: FocusLifecycleIntent;
  pending: boolean;
  error: string | null;
  nowMs?: number;
  onClose: () => void;
  onReload: () => void;
  onSubmit: (reason: string, outcome: string) => void;
}

export default function FocusLifecycleDialog({ object, intent, pending, error, nowMs, onClose, onReload, onSubmit }: FocusLifecycleDialogProps) {
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState("");
  const [selectedDismissReason, setSelectedDismissReason] = useState<string | null>(null);
  const firstDismissReasonRef = useRef<HTMLButtonElement>(null);
  const dismissReasonHelpId = useId();
  const copy = INTENT_TEXT[intent];
  const outcomeRequired = intent === "resolved" || intent === "accepted_risk";
  const showDismissPresets = intent === "dismissed" && object.objectType === "alert";
  return (
    <FocusDialog title={copy.title} description={copy.explanation} pending={pending} onClose={onClose}
      initialFocusRef={showDismissPresets ? firstDismissReasonRef : undefined}>
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim() && (!outcomeRequired || outcome.trim())) {
          setSelectedDismissReason(null);
          onSubmit(reason.trim(), outcome.trim());
        }
      }}>
        <p className="break-words text-sm font-medium text-text-primary">{object.title}</p>
        <p className="break-all text-xs text-text-faint">Episode: {object.activationId}</p>
        {object.objectType === "decision" && <FocusEvidenceValidity details={object.details} nowMs={nowMs} materialOnly />}
        {intent === "reactivate" && object.details.outcome && <p className="text-xs text-text-muted">Previous outcome retained in History: {object.details.outcome}</p>}
        {showDismissPresets && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text-secondary">Common reasons</legend>
            <p id={dismissReasonHelpId} className="text-xs text-text-muted">Choosing a reason dismisses this episode immediately.</p>
            <div className="flex flex-wrap gap-2">
              {DISMISS_REASONS.map((preset, index) => (
                <button
                  key={preset}
                  ref={index === 0 ? firstDismissReasonRef : undefined}
                  type="button"
                  disabled={pending}
                  aria-describedby={dismissReasonHelpId}
                  className={`${UI.button.secondary} min-h-11 text-sm disabled:opacity-50`}
                  onClick={() => {
                    setSelectedDismissReason(preset);
                    onSubmit(preset, "");
                  }}
                >
                  {pending && selectedDismissReason === preset ? "Dismissing..." : preset}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <label className="block space-y-1.5 text-sm text-text-secondary">
          <span>{intent === "reactivate" ? "Episode reason (required)" : showDismissPresets ? "Or enter a custom reason (required)" : "Reason (required)"}</span>
          <textarea required value={reason} disabled={pending} onChange={(event) => setReason(event.target.value)}
            className="min-h-24 w-full rounded-lg border border-border bg-bg-surface p-3 focus-visible:outline-accent" />
        </label>
        {intent !== "reactivate" && (
          <label className="block space-y-1.5 text-sm text-text-secondary">
            <span>{outcomeRequired ? "Outcome / remaining risk (required)" : "Outcome (optional)"}</span>
            <textarea required={outcomeRequired} value={outcome} disabled={pending} onChange={(event) => setOutcome(event.target.value)}
              className="min-h-24 w-full rounded-lg border border-border bg-bg-surface p-3 focus-visible:outline-accent" />
          </label>
        )}
        {error && <div role="alert" className="text-sm text-error">{error}<button type="button" disabled={pending} onClick={onReload} className="ml-2 min-h-11 underline">Reload item</button></div>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={pending} onClick={onClose} className={`${UI.button.secondary} min-h-11`}>Cancel</button>
          <button type="submit" disabled={pending || !reason.trim() || (outcomeRequired && !outcome.trim())}
            className={`${UI.button.primary} min-h-11 disabled:opacity-50`}>{pending ? "Saving..." : copy.title}</button>
        </div>
      </form>
    </FocusDialog>
  );
}
