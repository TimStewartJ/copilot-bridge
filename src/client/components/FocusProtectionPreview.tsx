import type { FocusProtectionPreview, FocusProtectionRequest } from "../api";
import { protectionTime } from "../focus-protection-helpers";

export function FocusProtectionDisclosures() {
  return <div className="min-w-0 space-y-2 text-xs text-text-muted [overflow-wrap:anywhere]">
    <p className="font-medium text-text-secondary">What protection does — and does not do</p>
    <ul className="list-inside list-disc space-y-1">
      <li>New automatic schedule and defer starts pause during protection.</li>
      <li>Manual starts remain allowed.</li>
      <li>Already-running work and in-flight/admitted starts continue; sessions are not stopped.</li>
      <li>Auto-resume and return prompts continue.</li>
      <li>External systems are unaffected.</li>
      <li>Recurring checks can expire unrun; expiry and run limits still apply.</li>
      <li>Cron slots coalesce into one original catch-up per schedule, not a replay of every tick.</li>
    </ul>
    <p>Protection does not grant agents authority beyond existing permissions.</p>
  </div>;
}

export function FocusProtectionBypasses({ request }: { request: Pick<FocusProtectionRequest, "allowNeedsInput" | "allowAuthorizedDeadlineOverride"> }) {
  return <p className="min-w-0 break-words text-xs text-text-muted">
    Needs-input bypass: {request.allowNeedsInput ? "allowed" : "off"}.
    {" "}Authorized deadline bypass: {request.allowAuthorizedDeadlineOverride ? "eligible Alerts only" : "off"}.
    {" "}Quiet and mute policy still applies.
  </p>;
}

export default function FocusProtectionPreviewPanel({ preview }: { preview: FocusProtectionPreview }) {
  const cronSlots = preview.schedules.filter((schedule) => schedule.type === "cron").reduce((total, schedule) => total + schedule.slotsDue, 0);
  const incompleteCron = preview.schedules.some((schedule) => schedule.type === "cron" && schedule.slotCountComplete === false);
  const onceSchedules = preview.schedules.filter((schedule) => schedule.type === "once").length;
  const onceDefers = preview.defers.filter((defer) => defer.kind === "defer").length;
  const expiringLoops = preview.defers.filter((defer) => defer.kind === "defer-loop" && defer.expiresDuringProtection).length;
  const at = (value: string) => protectionTime(value, preview.request.timezone);
  return <div className="min-w-0 space-y-4 break-words text-sm text-text-secondary [overflow-wrap:anywhere]" data-protection-preview="server">
    <div className="space-y-1 rounded-lg border border-info-border bg-info-surface p-3">
      <h3 className="font-semibold">Review the server preview</h3>
      <p>Reason: {preview.request.reason}</p>
      <p>{preview.request.startsAt ? `Starts ${at(preview.startsAt)}` : "Starts on confirmation"}.
        {" "}Ends <time dateTime={preview.endsAt}>{at(preview.endsAt)}</time> ({preview.request.timezone}).</p>
      {!preview.request.startsAt && <p className="text-xs">The end is fixed. Time spent reviewing shortens protection; refresh the preview to reset a duration preset.</p>}
      <FocusProtectionBypasses request={preview.request} />
      <p className="text-xs">Checked {at(preview.generatedAt)}. The server checks for changed impacts and conflicts again on confirmation.</p>
    </div>
    <section aria-label="Automatic starts affected" className="min-w-0 space-y-2">
      <h3 className="font-semibold">Automatic starts affected</h3>
      <p>{incompleteCron ? "At least " : ""}{cronSlots} cron slots due · {onceSchedules} one-shot schedules postponed · {onceDefers} one-shot defers postponed.</p>
      {incompleteCron && <p role="status" className="rounded-lg border border-warning/30 p-3 text-xs text-warning">
        Cron counting reached the preview work limit. Partial counts are lower bounds; an uncounted schedule is unknown, not empty.
        Protection and catch-up still cover all eligible work, including uncounted slots.
      </p>}
      {preview.schedules.length > 0 && <ul className="list-inside list-disc space-y-2">
        {preview.schedules.map((schedule) => <li key={schedule.id} className="min-w-0">
          <span className="font-medium">{schedule.name}</span>: {schedule.type === "cron"
            ? schedule.slotCountComplete === false
              ? schedule.slotsDue > 0 ? `at least ${schedule.slotsDue} cron slots due; eligible ticks coalesce, not replay`
                : "cron slot count unknown; any eligible missed ticks still coalesce"
              : `${schedule.slotsDue} cron slots due; one original catch-up, not ${schedule.slotsDue} replayed starts`
            : "one-shot schedule postponed"}.
          {schedule.firstScheduledFor && <> {schedule.slotCountComplete === false ? "First counted due" : "First due"} {at(schedule.firstScheduledFor)}
            {schedule.lastScheduledFor && schedule.firstScheduledFor !== schedule.lastScheduledFor
              && `; ${schedule.slotCountComplete === false ? "last counted due" : "last due"} ${at(schedule.lastScheduledFor)}`}.</>}
          {schedule.expiresAt && ` Expires ${at(schedule.expiresAt)}.`}
        </li>)}
      </ul>}
      {preview.defers.length > 0 && <ul className="list-inside list-disc space-y-2">
        {preview.defers.map((defer) => <li key={defer.id} className="min-w-0">
          <span className="font-medium">{defer.name}</span>: {defer.kind === "defer-loop" ? "recurring check paused" : "one-shot defer postponed"}; due {at(defer.scheduledFor)}.
          {defer.expiresAt && ` Expires ${at(defer.expiresAt)}.`}
          {defer.expiresDuringProtection && <span className="text-warning"> Can expire unrun during protection.</span>}
        </li>)}
      </ul>}
      <p className={expiringLoops ? "text-warning" : "text-text-muted"}>{expiringLoops} recurring checks can expire unrun before protection ends.</p>
      {preview.schedules.length === 0 && preview.defers.length === 0 && <p className="text-text-muted">No currently known automatic starts fall in this preview. New work may arrive later.</p>}
      <p className="text-xs text-text-muted">Postponed work can start after protection only if it is still eligible.</p>
      <p className="text-xs text-text-muted">Counts use current configurations. Future recurring times can shift as checks finish; new work or intervention conflicts may arrive after confirmation.</p>
    </section>
    <section aria-label="Current needs-input sessions" className="min-w-0 space-y-2">
      <h3 className="font-semibold">Current needs-input sessions ({preview.needsInput.length})</h3>
      {preview.needsInput.length === 0 ? <p className="text-text-muted">None currently reported by the server.</p>
        : <ul className="list-inside list-disc space-y-2">{preview.needsInput.map((session) => <li key={session.sessionId}>
          {session.title} · {session.pendingUserInputCount} pending inputs
          {session.muted ? " · Muted (quiet policy still applies)" : " · Not muted"}
          {session.busy && " · Work in flight"}.
        </li>)}</ul>}
    </section>
    <section aria-label="Intervention conflicts" className="min-w-0 space-y-2">
      <h3 className="font-semibold">Intervention conflicts ({preview.interventions.length})</h3>
      <p className="text-xs text-text-muted">All currently known open Alert and Decision deadlines before the end, including quiet concerns. Bypass permission does not acknowledge this risk.</p>
      {preview.interventions.length === 0 ? <p className="text-text-muted">No currently known intervention conflicts in this preview; this is not an assurance about external systems.</p>
        : <ul className="list-inside list-disc space-y-3 text-warning">{preview.interventions.map((item) => <li key={`${item.objectId}:${item.activationId}`}>
          <span className="font-medium">{item.title}</span> · {item.objectType === "alert" ? "Alert" : "Decision"} · intervene by {at(item.interventionBy)}.
          {" "}Task state: {item.taskState}; delivery: {item.notificationMode}.
          {" "}Consequence of delay: {item.consequenceOfDelay || "not specified"}.
        </li>)}</ul>}
    </section>
    <section aria-label="Work in flight" className="min-w-0 space-y-2">
      <h3 className="font-semibold">Work in flight — continues ({preview.inFlight.length})</h3>
      {preview.inFlight.length === 0 ? <p className="text-text-muted">None currently reported. Starts already admitted may still continue.</p>
        : <ul className="list-inside list-disc space-y-1">{preview.inFlight.map((work) => <li key={`${work.kind}:${work.id}`}>{work.name} · {work.kind}</li>)}</ul>}
      <p>{preview.continuingRecoveryPrompts} recovery/return prompts currently known; auto-resume and returns continue.</p>
    </section>
  </div>;
}
