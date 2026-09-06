import { useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { ExternalLink, MessageSquare, Pin } from "lucide-react";
import type { FocusEvidence, FocusLifecycle, FocusObject, FocusSnapshot } from "../api";
import { DEFAULT_FOCUS_ACTION_LABEL, DEFAULT_FOCUS_CHAT_LABEL } from "../focus-item-helpers";
import { FOCUS_LIFECYCLE_LABELS, focusTime, isFocusOpen, isFocusReadFresh } from "../focus-view-model";
import { useFocusNotificationDeliveriesQuery } from "../hooks/queries/useFocus";
import { timeAgo } from "../time";
import CodeBlock from "./CodeBlock";
import VisualArtifactCard from "./VisualArtifactCard";
import { APP_PROSE } from "./shared/prose-classes";
import { UI } from "./shared/design-system";
import type { FocusLifecycleIntent } from "./FocusLifecycleDialog";
import FocusEvidenceValidity from "./FocusEvidenceValidity";

interface FocusCardProps {
  card: FocusObject;
  pending?: boolean;
  expanded?: boolean;
  readOnly?: boolean;
  nowMs?: number;
  snapshot?: FocusSnapshot;
  onToggleExpanded?: () => void;
  onSelectTask: (taskId: string, options?: { checklistItemId?: string }) => void;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  onAction: (card: FocusObject) => void;
  onChat?: (card: FocusObject) => void;
  onLifecycle: (card: FocusObject, intent: FocusLifecycleIntent | "acknowledged") => void;
  onPromote: (card: FocusObject) => void;
  onDelete: (card: FocusObject) => void;
  onInspectHistory?: (id: string) => void;
}

const BUTTON = `${UI.button.secondary} inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 text-xs focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50`;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(https?|mailto|tel):/i;

function MarkdownLink({ href, node: _node, ...props }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const safe = href && URI_SCHEME.test(href) && !SAFE_SCHEME.test(href) ? undefined : href;
  const external = Boolean(safe && (SAFE_SCHEME.test(safe) || safe.startsWith("//")));
  return <a {...props} href={safe} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} />;
}

export function FocusMarkdown({ children }: { children: string }) {
  return <div className={`max-w-none min-w-0 break-words text-sm leading-relaxed ${APP_PROSE} prose-pre:max-w-full prose-pre:overflow-x-auto prose-a:break-all`}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock, a: MarkdownLink }}>{children}</ReactMarkdown>
  </div>;
}

export function FocusEvidenceList({ evidence }: { evidence: FocusEvidence[] }) {
  return evidence.length === 0
    ? <p className="text-xs text-warning">No supporting evidence provided; confidence is not established.</p>
    : <ul className="space-y-2">
      {evidence.map((entry, index) => <li key={index} className="min-w-0 rounded-lg border border-border/60 p-2 text-text-muted">
        <FocusMarkdown>{typeof entry === "string" ? entry : entry.summary}</FocusMarkdown>
        {typeof entry !== "string" && entry.observedAt && <p className="mt-1 text-xs">Observed: <time dateTime={entry.observedAt}>{focusTime(entry.observedAt)}</time></p>}
        {typeof entry !== "string" && entry.url && <a href={entry.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 text-xs text-accent underline">Open evidence <ExternalLink size={12} /></a>}
      </li>)}
    </ul>;
}

export function FocusLifecycleBadge({ lifecycle }: { lifecycle: FocusLifecycle }) {
  const tone = lifecycle === "resolved" ? "border-success/25 text-success"
    : lifecycle === "dismissed" ? "border-border text-text-muted"
      : lifecycle === "accepted_risk" ? "border-warning/25 text-warning" : "border-info-border text-info";
  return <span data-focus-lifecycle={lifecycle} className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{FOCUS_LIFECYCLE_LABELS[lifecycle]}</span>;
}

function DeliveryEvidence({ object }: { object: FocusObject }) {
  const [expanded, setExpanded] = useState(false);
  const query = useFocusNotificationDeliveriesQuery(expanded);
  const records = query.data?.filter((delivery) => delivery.objectId === object.id && delivery.activationId === object.activationId) ?? [];
  return <div className="mt-2">
    <button type="button" className={BUTTON} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>Notification delivery evidence</button>
    {expanded && <div className="mt-2 space-y-2 text-xs text-text-muted">
      <p>Latest 100 delivery records, filtered to this episode. Eligibility, delivery, viewing, and resolution are separate.</p>
      {query.isLoading && <p role="status">Loading delivery records...</p>}
      {query.error && <p role="alert">Delivery records unavailable: {query.error.message} <button type="button" className="min-h-11 underline" onClick={() => void query.refetch()}>Retry delivery records</button></p>}
      {!query.isLoading && !query.error && records.length === 0 && <p>No record in this window. Eligibility and delivery are unknown, not confirmed.</p>}
      {records.map((delivery) => <div key={delivery.id} className="rounded-lg border border-border p-2">
        <p>Delivery: {delivery.status} - {delivery.reason}</p>
        {delivery.suppressionReason && <p>Suppressed: {delivery.suppressionReason}</p>}
        {delivery.resolvedGrantId && <p className="break-all">Authorized by grant: {delivery.resolvedGrantId}</p>}
        {delivery.pendingUntil && <p>Next review: {focusTime(delivery.pendingUntil)}</p>}
        {delivery.sentAt && <p>Sent: {focusTime(delivery.sentAt)}. Sending is not acknowledgement.</p>}
        {delivery.error && <p className="text-error">{delivery.error}</p>}
      </div>)}
    </div>}
  </div>;
}

export default function FocusCard({
  card, pending = false, expanded = true, readOnly = false, nowMs = Date.now(), snapshot, onToggleExpanded,
  onSelectTask, onSelectSession, onAction, onChat, onLifecycle, onPromote, onDelete, onInspectHistory,
}: FocusCardProps) {
  const details = card.details;
  const open = isFocusOpen(card.lifecycle);
  const kind = card.objectType === "event" ? card.category.replace(/[-_]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase()) : card.objectType === "alert" ? "Alert" : "Decision";
  const metadataSource = typeof card.metadata?.source === "string" ? card.metadata.source.trim().replace(/\s+/g, " ") : "";
  const source = metadataSource.length > 32 ? `${metadataSource.slice(0, 29).trimEnd()}...` : metadataSource;
  const validity = !details.observedAt || !details.validUntil ? "Observation validity unknown"
    : Date.parse(details.validUntil) <= nowMs ? "Observation validity expired" : "Within stated observation validity";
  const interventionLate = details.interventionBy !== null && Date.parse(details.interventionBy) <= nowMs;
  const grant = snapshot?.authorityConstraints.find((candidate) => details.authorizationGrantId
    ? candidate.id === details.authorizationGrantId
    : candidate.sourceFamily === details.sourceFamily && candidate.producer === details.producer && candidate.taskId === card.taskId);
  const authorityFresh = snapshot && isFocusReadFresh(Date.parse(snapshot.generatedAt), nowMs) && snapshot.domainHealth.authority.status === "ok";
  const grantActive = authorityFresh && grant?.currentlyActive && !grant.orphanedAt && grant.status === "active"
    && Date.parse(grant.validUntil) > nowMs && Date.parse(grant.validFrom) <= nowMs
    && grant.sourceFamily === details.sourceFamily && grant.producer === details.producer && grant.taskId === card.taskId
    && (card.taskState === "active" || card.taskState === "global" || card.taskState === "muted");
  const linkedOpenCount = card.linkedActions.filter((link) => !link.action.done).length;
  const links = [...(card.url ? [{ label: "Open", url: card.url }] : []), ...card.links];

  return (
    <article data-focus-object-id={card.id} aria-busy={pending || undefined}
      className={`${UI.surface.card} min-w-0 overflow-hidden rounded-xl border-l-4 p-4 ${card.objectType === "alert" && open ? "border-l-error" : card.objectType === "decision" && open ? "border-l-warning" : "border-l-border"} ${pending ? "opacity-80" : ""}`}>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
          {source && <span title={metadataSource} className="font-medium">{source}</span>}
          <span>{kind}</span>
          {card.objectType === "event" && <span>Event</span>}
          <FocusLifecycleBadge lifecycle={card.lifecycle} />
          {card.pinned && <span className="inline-flex items-center gap-1 text-accent"><Pin size={11} />Pinned</span>}
          {pending && <span role="status">Saving...</span>}
        </div>
        <h4 className="break-words text-base font-semibold leading-snug text-text-primary">{card.title}</h4>
        <p className="break-words text-xs text-text-faint">{card.taskTitle ?? (card.taskState === "orphaned" ? "Removed task" : "Global Focus")} · {card.taskState} · Updated {timeAgo(card.updatedAt)}</p>
      </header>

      <div className="mt-3 space-y-2 text-sm text-text-secondary">
        {card.lifecycle === "acknowledged" && <p className="text-info">{card.objectType === "event" ? "Recorded acknowledgement; the Event itself is not an obligation." : "Acknowledged, not resolved. The concern remains open."}</p>}
        {card.lifecycle === "handed_off" && <p className="text-info">{card.objectType === "event" ? "Work was handed off from this observation. Its Action state is separate." : "Handed off, not resolved. Linked execution does not prove the outcome."}</p>}
        {card.objectType === "event" ? (
          <p className="text-xs text-text-muted">An observation, not an obligation. Create an Action only when you accept executable work.</p>
        ) : (
          <>
            {card.objectType === "alert" && <div><span className="font-medium">Impact / why now: </span>{details.impact ?? "Impact not provided; attention rationale is incomplete."}</div>}
            <div><span className="font-medium">Consequence of waiting: </span>{details.consequenceOfDelay ?? "Not specified; absence of a stated consequence is not assurance."}</div>
            {card.objectType === "decision" && <div><span className="font-medium">Recommendation: </span>{details.recommendation ?? "No recommendation provided."}</div>}
          </>
        )}
        <p className={`text-xs ${interventionLate && open ? "font-medium text-warning" : "text-text-muted"}`}>
          {interventionLate && open ? "Intervention time reached / passed: " : "Intervene by: "}
          {details.interventionBy ? <time dateTime={details.interventionBy}>{focusTime(details.interventionBy)}</time> : "Not specified"}
        </p>
        {(card.objectType === "decision" || details.fallback) && <div className="text-xs"><span className="font-medium">No response / fallback: </span>{details.fallback ?? "Not specified. Silence is not approval."}</div>}
        {card.objectType === "decision" && <FocusEvidenceValidity details={details} nowMs={nowMs} />}
        {(card.objectType === "alert" || (card.objectType === "event" && expanded)) && <p className={`text-xs ${validity !== "Within stated observation validity" ? "text-warning" : "text-text-muted"}`}>
          {validity}. Observed {focusTime(details.observedAt)}; valid until {focusTime(details.validUntil)}.
        </p>}
        {!open && <div className="rounded-lg border border-border bg-bg-secondary p-3">
          <p>Reason: {details.resolutionReason ?? "No recorded reason"}</p>
          <p className="mt-1">Outcome: {details.outcome ?? "No outcome recorded"}</p>
        </div>}
      </div>

      {card.linkedActions.length > 0 && <div className="mt-3 rounded-lg border border-border bg-bg-secondary/50 p-3">
        <p className="text-xs font-medium text-text-secondary">Linked Actions: {linkedOpenCount} open · {card.linkedActions.length - linkedOpenCount} completed</p>
        <p className="mt-1 text-xs text-text-muted">{card.objectType === "event" ? "Linked Action state is separate from this observation." : `Action completion does not resolve this ${card.objectType}.`}</p>
        {card.linkedActions.map((link) => <div key={`${link.activationId}:${link.actionId}`} className="mt-2 break-words text-xs text-text-secondary">
          <span className="font-medium">{link.action.text}</span> — {link.action.done ? "Action completed" : "Work open"}{link.activationId !== card.activationId ? " (earlier episode)" : ""}
          <div className="flex flex-wrap items-center gap-2">
            {link.action.taskId ? <button type="button" className="min-h-11 text-accent underline" onClick={() => onSelectTask(link.action.taskId!, { checklistItemId: link.actionId })}>Open linked Action in task</button>
              : <button type="button" className="min-h-11 text-accent underline" onClick={() => onInspectHistory ? onInspectHistory(link.actionId) : document.getElementById("focus-actions")?.scrollIntoView()}>Global Actions</button>}
          </div>
        </div>)}
      </div>}

      <div className="mt-3 flex flex-wrap gap-2">
        {!readOnly && open ? <>
          {card.objectType !== "event" && card.lifecycle === "active" && <button type="button" disabled={pending} className={BUTTON} onClick={() => onLifecycle(card, "acknowledged")}>Acknowledge</button>}
          <button type="button" disabled={pending} className={`${UI.button.primary} min-h-11 text-xs disabled:opacity-50`} onClick={() => onPromote(card)}>{card.objectType === "event" ? "Create Action" : "Hand off / Create Action"}</button>
          {card.objectType !== "event" && (
          <details>
            <summary className={`${BUTTON} cursor-pointer`}>Lifecycle options</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={pending} className={BUTTON} onClick={() => onLifecycle(card, "resolved")}>Resolve</button>
              <button type="button" disabled={pending} className={BUTTON} onClick={() => onLifecycle(card, "accepted_risk")}>Accept risk</button>
              <button type="button" disabled={pending} className={BUTTON} onClick={() => onLifecycle(card, "dismissed")}>Dismiss</button>
            </div>
          </details>
          )}
        </> : !readOnly && card.objectType !== "event" ? <button type="button" disabled={pending} className={BUTTON} onClick={() => onLifecycle(card, "reactivate")}>Reactivate as a new episode</button> : null}
        {onToggleExpanded && <button type="button" aria-expanded={expanded} disabled={pending} className={BUTTON} onClick={onToggleExpanded}>{expanded ? "Hide details" : "Review details"}</button>}
      </div>

      {expanded && <div className="mt-4 space-y-4 border-t border-border pt-4">
        {card.body && <FocusMarkdown>{card.body}</FocusMarkdown>}
        {card.objectType === "decision" && <section>
          <h5 className="mb-2 text-xs font-semibold text-text-primary">Alternatives</h5>
          {details.alternatives.length ? <ul className="list-inside list-disc space-y-1 text-sm text-text-secondary">{details.alternatives.map((alternative, index) => <li key={index} className="break-words">{alternative}</li>)}</ul>
            : <p className="text-xs text-warning">Alternatives not provided. Review the proposal before authorizing work.</p>}
        </section>}
        <dl className="grid min-w-0 gap-2 text-xs text-text-muted sm:grid-cols-2">
          <div><dt className="font-medium text-text-secondary">Source family</dt><dd className="break-words">{details.sourceFamily ?? "Not recorded"}</dd></div>
          <div><dt className="font-medium text-text-secondary">Producer</dt><dd className="break-words">{details.producer ?? "Not recorded"}</dd></div>
          <div><dt className="font-medium text-text-secondary">Priority (classification, not evidence)</dt><dd>{card.priority}</dd></div>
          <div><dt className="font-medium text-text-secondary">Meaningful change</dt><dd>{focusTime(details.lastMeaningfulChangeAt)}</dd></div>
        </dl>
        {details.episodeReason && <p className="text-xs text-text-secondary">Episode reason: {details.episodeReason}</p>}
        <section><h5 className="mb-2 text-xs font-semibold text-text-primary">Evidence</h5><FocusEvidenceList evidence={details.evidence} /></section>
        {card.objectType === "alert" && <section className="rounded-lg border border-border p-3 text-xs text-text-secondary">
          <h5 className="font-semibold">Authority and notification eligibility</h5>
          <p className="mt-2">Requested mode: {details.notificationMode}. Persistence alone does not authorize interruption.</p>
          <p className="mt-2">{grantActive ? `Matching active grant: ${grant!.title}` : "No currently verified matching grant. Immediate eligibility is not established."}</p>
          {details.authorizationGrantId && <p className="mt-1 break-all">Requested grant: {details.authorizationGrantId}</p>}
          {grant && <div className="mt-2 space-y-1">
            <p>Scope: {grant.scope}</p><p>Valid: {focusTime(grant.validFrom)} to {focusTime(grant.validUntil)}</p>
            <p>Immediate permission: {grant.allowImmediate ? "permitted by this grant; delivery policy still applies" : "not permitted"}</p>
            {grant.constraints.length > 0 && <ul className="list-inside list-disc">{grant.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul>}
          </div>}
          <p className="mt-2">Fresh evidence, matching authority, task state, quiet hours and notification policy all affect delivery.</p>
          <DeliveryEvidence object={card} />
        </section>}
        {card.visual && <div className="min-w-0 overflow-hidden rounded-xl border border-border p-2"><VisualArtifactCard visual={card.visual} /></div>}
        <div className="flex flex-wrap gap-2">
          {!readOnly && card.objectType !== "event" && open && card.launchPrompt && <button type="button" disabled={pending} className={`${UI.button.primary} min-h-11 text-xs`} onClick={() => onAction(card)}><MessageSquare size={14} />{card.launchPrompt.label ?? DEFAULT_FOCUS_ACTION_LABEL}</button>}
          {!readOnly && onChat && <button type="button" disabled={pending} className={BUTTON} onClick={() => onChat(card)}>{DEFAULT_FOCUS_CHAT_LABEL}</button>}
          {card.taskId && <button type="button" className={BUTTON} onClick={() => onSelectTask(card.taskId!)}>Open task</button>}
          {card.sessionId && <button type="button" className={BUTTON} onClick={() => onSelectSession(card.sessionId!, card.taskId ?? undefined)}>Open session</button>}
          {links.map((link, index) => <a key={`${link.url}:${index}`} href={link.url} target="_blank" rel="noopener noreferrer" className={`${BUTTON} break-all`}>{link.label}<ExternalLink size={12} /></a>)}
          {onInspectHistory && <button type="button" className={BUTTON} onClick={() => onInspectHistory(card.id)}>Object history</button>}
        </div>
        {!readOnly && card.objectType !== "event" && <details><summary className="min-h-11 cursor-pointer text-xs text-text-faint">Record options</summary><button type="button" disabled={pending} className={`${BUTTON} text-error`} onClick={() => onDelete(card)}>Delete item</button></details>}
      </div>}
    </article>
  );
}
