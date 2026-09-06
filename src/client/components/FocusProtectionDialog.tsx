import { useEffect, useRef, useState } from "react";
import { ApiError, type FocusProtectionPreview, type FocusProtectionWindow } from "../api";
import { buildFocusProtectionRequest, type FocusProtectionForm, type ProtectionDuration } from "../focus-protection-helpers";
import { useCreateFocusProtectionMutation, usePreviewFocusProtectionMutation } from "../hooks/queries/useFocusProtection";
import FocusDialog from "./FocusDialog";
import FocusProtectionHistory from "./FocusProtectionHistory";
import FocusProtectionPreviewPanel, { FocusProtectionDisclosures } from "./FocusProtectionPreview";
import { UI } from "./shared/design-system";

const INPUT = "min-h-11 w-full min-w-0 max-w-full rounded-lg border border-border bg-bg-surface p-2 text-sm text-text-primary";
const BUTTON = `${UI.button.secondary} min-h-11 min-w-0 max-w-full whitespace-normal break-words`;

export default function FocusProtectionDialog({
  onClose, onCreated, unavailable, onRetryStatus,
}: {
  onClose: () => void;
  onCreated: (window: FocusProtectionWindow) => void;
  unavailable: string | null;
  onRetryStatus: () => void;
}) {
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [form, setForm] = useState<FocusProtectionForm>({
    reason: "", start: "now", startsAtLocal: "", duration: "60", customMinutes: "120", endsAtLocal: "",
    allowNeedsInput: true, allowAuthorizedDeadlineOverride: false,
  });
  const [preview, setPreview] = useState<FocusProtectionPreview | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [previewExpired, setPreviewExpired] = useState(false);
  const [conflictsConfirmed, setConflictsConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<"preview" | "create" | null>(null);
  const working = useRef(false);
  const previewMutation = usePreviewFocusProtectionMutation();
  const createMutation = useCreateFocusProtectionMutation();
  const busy = operation !== null;
  const conflicts = (preview?.interventions.length ?? 0) > 0;

  useEffect(() => {
    setPreviewExpired(false);
    if (!preview) return;
    const expiresAt = Date.now() + Date.parse(preview.endsAt) - Date.parse(preview.generatedAt);
    let timer: ReturnType<typeof setTimeout>;
    const checkExpiry = () => {
      const remaining = expiresAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        setPreviewExpired(true);
        return;
      }
      timer = setTimeout(checkExpiry, Math.min(remaining, 24 * 60 * 60_000));
    };
    checkExpiry();
    return () => clearTimeout(timer);
  }, [preview]);

  const update = <K extends keyof FocusProtectionForm>(key: K, value: FocusProtectionForm[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setPreview(null);
    setConflictsConfirmed(false);
    setError(null);
  };
  const refreshPreview = async () => {
    if (working.current || unavailable) return;
    working.current = true;
    setOperation("preview");
    setError(null);
    setPreviewStale(true);
    setConflictsConfirmed(false);
    try {
      const request = buildFocusProtectionRequest(form, Date.now(), timezone);
      const result = await previewMutation.mutateAsync(request);
      setPreview(result);
      setPreviewStale(false);
    } catch (failure) {
      setError(`Preview unavailable; impacts are unknown, not zero. ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      working.current = false;
      setOperation(null);
    }
  };
  const confirm = async () => {
    if (working.current || unavailable || !preview || previewStale || previewExpired || (conflicts && !conflictsConfirmed)) return;
    working.current = true;
    setOperation("create");
    setError(null);
    try {
      const window = await createMutation.mutateAsync({
        ...preview.request,
        confirmationToken: preview.confirmationToken,
        confirmInterventionConflicts: conflicts && conflictsConfirmed,
      });
      onCreated(window);
    } catch (failure) {
      setPreviewStale(true);
      setConflictsConfirmed(false);
      setError(failure instanceof ApiError && failure.status === 409
        ? `Confirmation requires a new preview. Refresh and review the changed impacts/conflicts, then acknowledge them again. ${failure.message}`
        : `Protection creation could not be confirmed. Check the server status before trying again; do not assume nothing changed. ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      working.current = false;
      setOperation(null);
    }
  };

  return <FocusDialog title="Protect focus" description="Preview which automatic starts will wait, then explicitly confirm a time-limited protection window." pending={busy} onClose={onClose}>
    <div className="min-w-0 max-w-full space-y-4 break-words [overflow-wrap:anywhere]">
      <FocusProtectionDisclosures />
      <p className="text-xs text-text-muted">Only otherwise eligible, authorized immediate Alerts with intervention deadlines before protection ends can bypass when allowed. Quiet and mute policy still applies; Decisions do not gain this bypass.</p>
      {unavailable && <div role="alert" className="space-y-2 text-sm text-warning">
        <p>{unavailable} No new protection can be confirmed from an unknown state.</p>
        <button type="button" className={BUTTON} disabled={busy} onClick={onRetryStatus}>Retry protection status</button>
      </div>}
      {!preview && <form className="min-w-0 space-y-4" onSubmit={(event) => { event.preventDefault(); void refreshPreview(); }}>
        <label className="block min-w-0 space-y-1 text-xs text-text-muted">
          <span>Reason (required)</span>
          <textarea value={form.reason} required rows={2} maxLength={1000} disabled={busy} className={INPUT} onChange={(event) => update("reason", event.target.value)} />
        </label>
        <label className="block min-w-0 space-y-1 text-xs text-text-muted">
          <span>Start protection</span>
          <select value={form.start} disabled={busy} className={INPUT} onChange={(event) => update("start", event.target.value as FocusProtectionForm["start"])}>
            <option value="now">On confirmation</option><option value="scheduled">At a specified time</option>
          </select>
        </label>
        {form.start === "scheduled" && <label className="block min-w-0 space-y-1 text-xs text-text-muted">
          <span>Start time ({timezone})</span>
          <input type="datetime-local" required value={form.startsAtLocal} disabled={busy} className={INPUT} onChange={(event) => update("startsAtLocal", event.target.value)} />
        </label>}
        <fieldset className="min-w-0 space-y-2" disabled={busy}>
          <legend className="text-xs text-text-muted">Protection duration</legend>
          <div className="flex min-w-0 flex-wrap gap-2">{([
            ["30", "30 minutes"], ["60", "60 minutes"], ["90", "90 minutes"],
            ["custom-duration", "Custom duration"], ["custom-end", "Custom end time"],
          ] as [ProtectionDuration, string][]).map(([value, label]) => <button type="button" key={value} aria-pressed={form.duration === value}
            disabled={busy} onClick={() => update("duration", value)} className={`${BUTTON} ${form.duration === value ? "ring-2 ring-accent" : ""}`}>{label}</button>)}</div>
          {form.duration === "custom-duration" && <label className="block min-w-0 space-y-1 text-xs text-text-muted">
            <span>Duration in minutes</span>
            <input type="number" min="1" max="10080" step="1" required value={form.customMinutes} disabled={busy} className={INPUT} onChange={(event) => update("customMinutes", event.target.value)} />
          </label>}
          {form.duration === "custom-end" && <label className="block min-w-0 space-y-1 text-xs text-text-muted">
            <span>End time ({timezone})</span>
            <input type="datetime-local" required value={form.endsAtLocal} disabled={busy} className={INPUT} onChange={(event) => update("endsAtLocal", event.target.value)} />
          </label>}
          <p className="text-xs text-text-faint">At most 7 days. Times use {timezone} and are submitted as absolute instants. Duration presets are calculated when you request a preview.</p>
        </fieldset>
        <label className="flex min-h-11 min-w-0 items-start gap-2 py-2 text-sm text-text-secondary">
          <input type="checkbox" checked={form.allowNeedsInput} disabled={busy} className="mt-0.5 size-5 shrink-0" onChange={(event) => update("allowNeedsInput", event.target.checked)} />
          <span className="min-w-0">Allow needs-input notifications (quiet policy still applies)</span>
        </label>
        <label className="flex min-h-11 min-w-0 items-start gap-2 py-2 text-sm text-text-secondary">
          <input type="checkbox" checked={form.allowAuthorizedDeadlineOverride} disabled={busy} className="mt-0.5 size-5 shrink-0" onChange={(event) => update("allowAuthorizedDeadlineOverride", event.target.checked)} />
          <span className="min-w-0">Allow eligible authorized immediate Alert deadlines to bypass</span>
        </label>
        <button type="submit" disabled={busy || Boolean(unavailable) || !form.reason.trim()} className={`${UI.button.primary} min-h-11 min-w-0 max-w-full whitespace-normal`}>
          {operation === "preview" ? "Loading server preview…" : error ? "Retry preview" : "Preview protection"}
        </button>
      </form>}
      {preview && <>
        {(previewStale || previewExpired) && <p role="status" className="text-sm text-warning">
          {previewExpired ? "The preview end time has passed." : "This is the last known preview, not a current confirmation."} Refresh the preview before confirming.
        </p>}
        <FocusProtectionPreviewPanel preview={preview} />
        {conflicts && <label className="flex min-h-11 min-w-0 items-start gap-2 rounded-lg border border-warning/40 p-3 text-sm text-warning">
          <input type="checkbox" required checked={conflictsConfirmed} disabled={busy || previewStale || previewExpired} className="mt-0.5 size-5 shrink-0" onChange={(event) => setConflictsConfirmed(event.target.checked)} />
          <span className="min-w-0">I acknowledge the intervention conflicts before protection ends, including the consequences of delay.</span>
        </label>}
        <div className="flex min-w-0 flex-wrap gap-2">
          <button type="button" disabled={busy || Boolean(unavailable) || previewStale || previewExpired || (conflicts && !conflictsConfirmed)} className={`${UI.button.primary} min-h-11 min-w-0 max-w-full whitespace-normal`} onClick={() => void confirm()}>
            {operation === "create" ? "Confirming protection…" : "Confirm protection"}
          </button>
          <button type="button" disabled={busy || Boolean(unavailable)} className={BUTTON} onClick={() => void refreshPreview()}>{operation === "preview" ? "Loading server preview…" : "Refresh preview"}</button>
          <button type="button" disabled={busy} className={BUTTON} onClick={() => { setPreview(null); setConflictsConfirmed(false); setError(null); }}>Edit protection</button>
        </div>
      </>}
      {operation === "preview" && <p role="status" className="text-sm text-text-muted">Checking server impacts and conflicts. Unknown is not zero; nothing has been confirmed.</p>}
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <FocusProtectionHistory />
    </div>
  </FocusDialog>;
}
