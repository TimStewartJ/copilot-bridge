import { useEffect, useRef, useState } from "react";
import { Shield } from "lucide-react";
import type { FocusProtectionWindow } from "../api";
import { protectionCountdown, protectionTime } from "../focus-protection-helpers";
import { useCancelFocusProtectionMutation, useFocusProtectionCurrentQuery } from "../hooks/queries/useFocusProtection";
import FocusDialog from "./FocusDialog";
import FocusProtectionDialog from "./FocusProtectionDialog";
import FocusProtectionHistory from "./FocusProtectionHistory";
import { FocusProtectionBypasses, FocusProtectionDisclosures } from "./FocusProtectionPreview";
import { UI } from "./shared/design-system";

const BUTTON = `${UI.button.secondary} min-h-11 min-w-0 max-w-full whitespace-normal break-words`;

export default function FocusProtectionControl() {
  const query = useFocusProtectionCurrentQuery();
  const cancelMutation = useCancelFocusProtectionMutation();
  const [dialog, setDialog] = useState<"create" | "details" | null>(null);
  const [recordedWindow, setRecordedWindow] = useState<FocusProtectionWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const working = useRef(false);
  useEffect(() => {
    if (query.isSuccess && !query.isFetching) setRecordedWindow(null);
  }, [query.isSuccess, query.isFetching, query.dataUpdatedAt, recordedWindow]);
  const uncertain = query.statusUnknown || query.isFetching;
  const recordedContext = recordedWindow && (!query.protection || recordedWindow.id === query.protection.id)
    ? recordedWindow : query.protection ?? query.data?.latest;
  const contextWindow = uncertain ? recordedContext : query.protection;
  const protection = contextWindow ?? null;
  const upcoming = uncertain && recordedWindow?.id === query.data?.upcoming?.id ? recordedWindow : query.data?.upcoming;
  const impacts = query.data?.impacts;
  const impactsKnown = query.data !== undefined && (!recordedWindow || protection?.id !== recordedWindow.id
    || [query.data.current?.id, query.data.upcoming?.id, query.data.latest?.id].includes(recordedWindow.id));
  const canCancel = protection?.status === "active" || protection?.status === "scheduled";
  const statusText = query.error ? `Protection status unknown: ${query.error.message}. Last known context is retained.`
    : query.boundaryReached ? "Time boundary reached — verifying protection status with the server. Do not assume protection cleared."
      : query.isPending || query.isFetching ? "Verifying protection status with the server…"
        : query.statusUnknown ? "Protection status is unknown. Retry the server check." : null;
  const unavailable = query.protection ? "A protection window is already active or scheduled."
    : uncertain ? "Protection status is not verified." : null;
  const refresh = () => { setError(null); void query.refetch(); };
  const cancel = async (window: FocusProtectionWindow) => {
    if (working.current) return;
    working.current = true;
    setCancelling(true);
    setError(null);
    try {
      setRecordedWindow(await cancelMutation.mutateAsync(window.id));
    } catch (failure) {
      setError(`Cancellation could not be confirmed: ${failure instanceof Error ? failure.message : String(failure)}. Check the server status; do not assume protection ended.`);
    } finally {
      working.current = false;
      setCancelling(false);
    }
  };
  const windowContext = (window: FocusProtectionWindow, compact = false) => <div className="min-w-0 space-y-1">
    <p className="font-medium">
      {uncertain ? `Last known protection: ${window.status}` : window.status === "active" ? "Focus protected" : `Protection ${window.status}`}
      {!uncertain && window.status === "active" && ` · ${protectionCountdown(Date.parse(window.endsAt) - query.nowMs)} remaining`}
      {!uncertain && window.status === "scheduled" && ` · starts in ${protectionCountdown(Date.parse(window.startsAt) - query.nowMs)}`}
    </p>
    <p className={`break-words ${compact ? "line-clamp-2" : ""}`}>{window.reason}</p>
    <p className="text-text-muted">{window.status === "scheduled" && `Starts ${protectionTime(window.startsAt, window.timezone)} · `}
      Ends {protectionTime(window.endsAt, window.timezone)} ({window.timezone}).</p>
    <FocusProtectionBypasses request={window} />
  </div>;
  const status = statusText && <p role={query.error ? "alert" : "status"} className="text-warning">{statusText}</p>;
  const summary = impactsKnown && impacts
    ? <p className="text-text-muted">{impacts.postponed} recorded postponements · {impacts.pending} pending.
      {" "}Counts are held work/slots, not a promise to replay every tick.</p>
    : <p className="text-warning">Postponement totals are not yet verified.</p>;

  return <div className={`min-w-0 max-w-full text-xs text-text-secondary [overflow-wrap:anywhere] ${protection || statusText ? "basis-full" : "sm:ml-auto"}`}
    data-focus-protection-state={query.statusUnknown ? "unknown" : query.isFetching ? "verifying" : protection?.status ?? "inactive"}>
    <div className="min-w-0 space-y-2">
      {status}
      {protection && <>{windowContext(protection, true)}{summary}</>}
      {error && <p role="alert" className="text-error">{error}</p>}
      <div className="flex min-w-0 flex-wrap gap-2">
        {!protection && <button type="button" className={`${BUTTON} inline-flex items-center gap-2`} disabled={uncertain || cancelling} onClick={() => setDialog("create")}><Shield size={14} className="shrink-0" />Protect focus</button>}
        {protection && <button type="button" className={BUTTON} onClick={() => setDialog("details")}>Protection details</button>}
        {canCancel && <button type="button" className={BUTTON} disabled={cancelling} onClick={() => void cancel(protection!)}>{cancelling ? "Cancelling protection…" : "Cancel protection"}</button>}
        {(query.statusUnknown || error) && <button type="button" className={BUTTON} disabled={query.isFetching || cancelling} onClick={refresh}>Retry protection status</button>}
      </div>
    </div>
    {dialog === "create" && <FocusProtectionDialog unavailable={unavailable} onRetryStatus={refresh} onClose={() => setDialog(null)} onCreated={(window) => {
      setRecordedWindow(window);
      setError(null);
      setDialog(null);
    }} />}
    {dialog === "details" && <FocusDialog title="Focus protection details" pending={cancelling} onClose={() => setDialog(null)}>
      <div className="min-w-0 max-w-full space-y-4 break-words text-sm text-text-secondary [overflow-wrap:anywhere]">
        {status}
        {protection ? windowContext(protection) : <p role="status">No active or scheduled protection in the latest server check.</p>}
        {upcoming && upcoming.id !== protection?.id && <div className="space-y-2">
          {windowContext(upcoming)}
          {upcoming.status === "scheduled" && <button type="button" className={BUTTON} disabled={cancelling} onClick={() => void cancel(upcoming)}>Cancel scheduled protection</button>}
        </div>}
        {summary}
        {impactsKnown && impacts && <section aria-label="Recorded protection impacts" className="min-w-0 space-y-2">
          <h3 className="font-medium">Recorded outcomes and recent postponements</h3>
          <p>{Object.entries(impacts.dispositions).map(([kind, count]) => `${kind}: ${count}`).join(" · ") || "No settled outcomes recorded."}</p>
          <p className="text-xs text-text-muted">At most 20 recent records are shown; totals above are not limited to this list.</p>
          <ul className="list-inside list-disc space-y-2">{impacts.recent.slice(0, 20).map((impact) => <li key={impact.id}>
            {impact.title ?? impact.workId} · {impact.kind} · due {protectionTime(impact.scheduledFor, protection?.timezone ?? "UTC")}
            {" "}· {impact.disposition ?? "pending"}.
          </li>)}</ul>
        </section>}
        <FocusProtectionDisclosures />
        <p className="text-xs text-text-muted">Only otherwise eligible, authorized immediate Alerts with deadlines before the end can bypass when allowed. Quiet and mute policy still applies.</p>
        {error && <p role="alert" className="text-error">{error}</p>}
        <div className="flex min-w-0 flex-wrap gap-2">
          {canCancel && <button type="button" className={BUTTON} disabled={cancelling} onClick={() => void cancel(protection!)}>{cancelling ? "Cancelling protection…" : "Cancel this protection"}</button>}
          <button type="button" className={BUTTON} disabled={query.isFetching || cancelling} onClick={refresh}>Refresh protection status</button>
        </div>
        <FocusProtectionHistory />
      </div>
    </FocusDialog>}
  </div>;
}
