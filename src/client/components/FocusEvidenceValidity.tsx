import type { FocusObjectDetails } from "../api";
import { focusEvidenceValidity, focusTime } from "../focus-view-model";

export default function FocusEvidenceValidity({ details, nowMs = Date.now(), materialOnly = false }: {
  details: Pick<FocusObjectDetails, "observedAt" | "validUntil">;
  nowMs?: number;
  materialOnly?: boolean;
}) {
  const state = focusEvidenceValidity(details, nowMs);
  if (materialOnly && state === "valid") return null;
  return <div data-evidence-validity={state} role="note"
    className={`text-xs ${state === "valid" ? "text-text-muted" : "rounded-lg border border-warning/25 bg-warning/5 p-3 text-warning"}`}>
    <p className={state === "valid" ? "" : "font-medium"}>
      {state === "expired" ? "Evidence validity expired. Recheck the evidence before judgment or handoff."
        : state === "unknown" ? "Evidence validity unknown. Do not infer a current basis for judgment or handoff."
          : "Within stated evidence validity; this is not proof of correctness."}
    </p>
    <p className="mt-1">Observed {focusTime(details.observedAt)}; valid until {focusTime(details.validUntil)}.</p>
  </div>;
}
