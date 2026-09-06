import type { FocusEpisodeSnapshot, FocusTransition } from "../api";
import { FOCUS_LIFECYCLE_LABELS, focusTime } from "../focus-view-model";
import { FocusEvidenceList, FocusLifecycleBadge, FocusMarkdown } from "./FocusCard";
import type { FocusInteractionProps } from "./FocusInteractions";
import { UI } from "./shared/design-system";

type HistoryNavigation = Pick<FocusInteractionProps, "onSelectTask" | "onSelectSession" | "onInspectHistory">;

const BUTTON = `${UI.button.secondary} min-h-11 text-xs`;

function RecordedTime({ label, value }: { label: string; value: string | null }) {
  return <div>
    <dt className="font-medium text-text-secondary">{label}</dt>
    <dd>{value ? <time dateTime={value}>{focusTime(value)}</time> : "Not recorded"}</dd>
  </div>;
}

function RecordedText({ label, value }: { label: string; value: string | null }) {
  return <div>
    <h6 className="mb-1 text-xs font-semibold text-text-primary">{label}</h6>
    {value ? <FocusMarkdown>{value}</FocusMarkdown> : <p className="text-xs text-text-muted">Not recorded.</p>}
  </div>;
}

export default function FocusEpisodeDetails({
  episode, onSelectTask, onSelectSession, onInspectHistory,
}: { episode: FocusEpisodeSnapshot } & HistoryNavigation) {
  const actionIds = [...new Set([...episode.linkedActionIds, ...episode.linkedActions.map((link) => link.actionId)])];
  const sessionIds = [...new Set([...(episode.sessionId ? [episode.sessionId] : []), ...episode.sessionIds])];

  return <div data-focus-episode-id={episode.activationId} className="min-w-0 space-y-4 rounded-lg border border-border bg-bg-surface p-3 text-sm text-text-secondary">
    <header className="space-y-2">
      <p className="text-xs text-text-muted">Retained episode snapshot — read-only. Later changes are not shown.</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span>{episode.objectType}{episode.category !== null ? ` · ${episode.category}` : ""}</span>
        <FocusLifecycleBadge lifecycle={episode.lifecycle} />
      </div>
      <h5 className="break-words font-semibold text-text-primary">{episode.title}</h5>
      <p className="break-all text-xs text-text-faint">Record ID: {episode.objectId}</p>
      <p className="break-all text-xs text-text-faint">Retained episode: {episode.activationId}</p>
    </header>

    {episode.body ? <FocusMarkdown>{episode.body}</FocusMarkdown> : <p className="text-xs text-text-muted">No body recorded.</p>}
    {episode.objectType === "event" && <p className="text-xs text-text-muted">An Event records an observation, not an obligation.</p>}
    {episode.objectType !== "event" && (episode.lifecycle === "handed_off" || episode.lifecycle === "acknowledged") && <p className="text-xs text-info">
      This snapshot records an unresolved concern. Linked execution does not establish its outcome.
    </p>}
    <div className="space-y-1 rounded-lg border border-border p-3 text-xs">
      <p>Outcome: {episode.outcome ?? "No outcome recorded"}</p>
      <p>Reason: {episode.resolutionReason ?? "No disposition reason recorded"}</p>
      {episode.episodeReason && <p>Episode reason: {episode.episodeReason}</p>}
    </div>

    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <RecordedText label="Impact" value={episode.impact} />
      <RecordedText label="Consequence of delay" value={episode.consequenceOfDelay} />
      <RecordedText label="Recommendation" value={episode.recommendation} />
      <RecordedText label="No response / fallback" value={episode.fallback} />
    </div>
    <section>
      <h6 className="mb-2 text-xs font-semibold text-text-primary">Alternatives</h6>
      {episode.alternatives.length > 0
        ? <ul className="list-inside list-disc space-y-1">{episode.alternatives.map((alternative, index) => <li key={index} className="break-words"><FocusMarkdown>{alternative}</FocusMarkdown></li>)}</ul>
        : <p className="text-xs text-text-muted">No alternatives recorded.</p>}
    </section>
    <section>
      <h6 className="mb-2 text-xs font-semibold text-text-primary">Retained evidence</h6>
      <FocusEvidenceList evidence={episode.evidence} />
    </section>

    <dl className="grid min-w-0 gap-2 text-xs text-text-muted sm:grid-cols-2">
      <RecordedTime label="Observed at" value={episode.observedAt} />
      <RecordedTime label="Valid until (recorded)" value={episode.validUntil} />
      <RecordedTime label="Intervene by (recorded)" value={episode.interventionBy} />
      <RecordedTime label="Meaningful change" value={episode.lastMeaningfulChangeAt} />
      <RecordedTime label="Created at" value={episode.createdAt} />
      <RecordedTime label="Updated at capture" value={episode.updatedAt} />
      <RecordedTime label="Status changed at" value={episode.statusChangedAt} />
      <RecordedTime label="Acknowledged at" value={episode.acknowledgedAt} />
      <RecordedTime label="Handed off at" value={episode.handedOffAt} />
      <RecordedTime label="Resolved at" value={episode.resolvedAt} />
      <div><dt className="font-medium text-text-secondary">Source family</dt><dd className="break-words">{episode.sourceFamily ?? "Not recorded"}</dd></div>
      <div><dt className="font-medium text-text-secondary">Producer</dt><dd className="break-words">{episode.producer ?? "Not recorded"}</dd></div>
    </dl>
    <p className="text-xs text-text-muted">These are retained observation and intervention times, not a current validity assessment.</p>

    <section className="space-y-2 text-xs">
      <h6 className="font-semibold text-text-primary">Retained task context</h6>
      <p className="break-words">Task at capture: {episode.taskTitle ?? episode.taskId ?? "No task linked"}</p>
      {episode.taskId && <p className="break-all text-text-muted">Task ID: {episode.taskId}</p>}
      {!episode.taskId && episode.taskTitle && <p className="text-text-muted">No task linked at capture.</p>}
      {(episode.originalTaskId || episode.originalTaskTitle) && <p className="break-words">Original task: {episode.originalTaskTitle ?? episode.originalTaskId}</p>}
      {episode.originalTaskId && <p className="break-all text-text-muted">Original task ID: {episode.originalTaskId}</p>}
      {episode.orphanedAt && <p className="text-warning">
        Original task removed at <time dateTime={episode.orphanedAt}>{focusTime(episode.orphanedAt)}</time>. This does not reassign the record to Global Focus.
      </p>}
      <div className="flex flex-wrap gap-2">
        {episode.taskId && <button type="button" className={BUTTON} onClick={() => onSelectTask(episode.taskId!)}>Open retained task</button>}
        {episode.originalTaskId && episode.originalTaskId !== episode.taskId && <button type="button" className={BUTTON} onClick={() => onSelectTask(episode.originalTaskId!)}>Open original task</button>}
      </div>
    </section>

    <section className="space-y-2 text-xs">
      <h6 className="font-semibold text-text-primary">Retained relationships</h6>
      <p className="text-text-muted">Linked Action and session IDs record relationships, not current work state, completion, or resolution. Navigation targets may no longer be available.</p>
      {actionIds.length === 0 ? <p className="text-text-muted">No Action links recorded.</p>
        : <ul className="space-y-2">
          {actionIds.map((actionId) => <li key={actionId} className="space-y-1 rounded-lg border border-border/60 p-2">
            <p className="break-all">Action ID: {actionId}</p>
            {episode.linkedActions.filter((link) => link.actionId === actionId).map((link, index) => <div key={index} className="space-y-1 text-text-muted">
              <p className="break-all">Source {link.sourceType}: {link.sourceId}</p>
              <p className="break-all">Linked episode: {link.activationId}</p>
              <p>Linked at: <time dateTime={link.createdAt}>{focusTime(link.createdAt)}</time></p>
              {onInspectHistory && link.sourceId !== episode.objectId && <button type="button" className={BUTTON} onClick={() => onInspectHistory(link.sourceId)}>Open linked source record</button>}
            </div>)}
            {onInspectHistory && <button type="button" className={BUTTON} onClick={() => onInspectHistory(actionId)}>Open linked Action record</button>}
          </li>)}
        </ul>}
      {sessionIds.length === 0 ? <p className="text-text-muted">No session links recorded.</p>
        : <ul className="space-y-2">
          {sessionIds.map((sessionId) => <li key={sessionId} className="rounded-lg border border-border/60 p-2">
            <p className="break-all">Session ID: {sessionId}{sessionId === episode.sessionId ? " (recorded on episode)" : ""}</p>
            <button type="button" className={BUTTON} onClick={() => onSelectSession(sessionId)}>Open retained session</button>
          </li>)}
        </ul>}
    </section>

    <details className="text-xs text-text-muted">
      <summary className="min-h-11 cursor-pointer py-3">Recorded metadata</summary>
      <div className="space-y-2 break-all">
        <p>Notification mode: {episode.notificationMode}</p>
        <p>Authorization grant ID: {episode.authorizationGrantId ?? "Not recorded"}</p>
        <p>This does not establish current authority or notification delivery.</p>
        <p>Content fingerprint: {episode.contentFingerprint}</p>
        <p>Snapshot schema: {episode.schemaVersion}</p>
      </div>
    </details>
  </div>;
}

export function FocusTransitionList({
  transitions, onSelectTask, onSelectSession, onInspectHistory,
}: { transitions: FocusTransition[] } & HistoryNavigation) {
  return <ol className="space-y-2">
    {transitions.map((transition) => {
      const { previousEpisode, ...otherDetails } = transition.details;
      return <li key={transition.id} className="min-w-0 space-y-1 rounded-lg border border-border/60 bg-bg-surface p-3 text-xs text-text-muted">
        <p className="break-words font-medium text-text-secondary">{transition.title}</p>
        <p className="font-medium text-text-secondary">
          {transition.fromLifecycle ? FOCUS_LIFECYCLE_LABELS[transition.fromLifecycle] : "Created"}
          {" → "}{transition.toLifecycle ? FOCUS_LIFECYCLE_LABELS[transition.toLifecycle] : "Deleted"}
        </p>
        <p>Reason: {transition.reason} · Actor: {transition.actor}</p>
        <time dateTime={transition.createdAt}>{focusTime(transition.createdAt)}</time>
        <p className="break-all text-text-faint">Transition episode: {transition.activationId}</p>
        <p className="break-all text-text-faint">{transition.objectType} record: {transition.objectId} · Transition ID: {transition.id}</p>
        <div className="flex flex-wrap gap-2">
          {transition.sessionId && <button type="button" className={BUTTON} onClick={() => onSelectSession(transition.sessionId!)}>Open transition session</button>}
          {transition.relatedActionId && onInspectHistory && <button type="button" className={BUTTON} onClick={() => onInspectHistory(transition.relatedActionId!)}>Open related Action</button>}
        </div>
        {(transition.sessionId || transition.relatedActionId) && <p>These are retained relationships, not proof of current work state or resolution.</p>}
        {previousEpisode ? <details>
          <summary className="min-h-11 cursor-pointer break-words py-3">State before this transition — episode {previousEpisode.activationId}</summary>
          <FocusEpisodeDetails episode={previousEpisode} onSelectTask={onSelectTask} onSelectSession={onSelectSession} onInspectHistory={onInspectHistory} />
        </details> : <p>No previous episode snapshot was retained with this transition. Prior details and outcome are unknown.</p>}
        {Object.keys(otherDetails).length > 0 && <details>
          <summary className="min-h-11 cursor-pointer py-3">Recorded transition details</summary>
          <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(otherDetails, null, 2)}</pre>
        </details>}
      </li>;
    })}
  </ol>;
}
