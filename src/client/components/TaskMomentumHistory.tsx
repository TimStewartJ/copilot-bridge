import { useQuery } from "@tanstack/react-query";
import { fetchTaskMomentumEvents, type TaskMomentumChange, type TaskMomentumEvent, type TaskMomentumField } from "../api";
import { queryKeys } from "../queryClient";
import { timeAgo } from "../time";
import { formatRevisit } from "../lib/task-revisit";
import { DS, cx } from "../design/tokens";
import { Button, DisclosureRow, EmptyHint, MetaLine, Section } from "../design/primitives";

export const TASK_MOMENTUM_HISTORY_LIMIT = 30;

const FIELD_LABELS: Record<TaskMomentumField, string> = {
  nextAction: "Next step",
  waitingOn: "Waiting for",
  nextTouchAt: "Revisit on",
  deferred: "Deferral",
  doneWhen: "Done when",
};

export function describeMomentumActor(event: Pick<TaskMomentumEvent, "source" | "scheduleName" | "sessionId">): string {
  if (event.source === "user") return "You";
  if (event.source === "system") return "Bridge";
  if (event.scheduleName) return event.scheduleName;
  return event.sessionId ? "Agent session" : "Agent";
}

function formatValue(field: TaskMomentumField, value: string | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "Deferred" : "Resumed";
  return field === "nextTouchAt" ? formatRevisit(value) : value;
}

function truncationNote(length: number | undefined): string | undefined {
  return length === undefined ? undefined : `Preview of ${length.toLocaleString()} characters`;
}

export function describeMomentumChange(change: TaskMomentumChange): { label: string; value: string; note?: string; previous?: string } {
  const label = FIELD_LABELS[change.field] ?? change.field;
  if (change.field === "deferred") {
    return { label, value: change.after ? "Deferred" : "Resumed" };
  }
  const previousValue = formatValue(change.field, change.before);
  const previous = previousValue ? { previous: previousValue } : {};
  if (change.after === null || change.after === "") {
    return { label, value: "Cleared", ...previous };
  }
  const note = truncationNote(change.afterLength);
  return { label, value: formatValue(change.field, change.after), ...(note ? { note } : {}), ...previous };
}

function MomentumEventRow({ event, onSelectSession }: { event: TaskMomentumEvent; onSelectSession?: (sessionId: string) => void }) {
  const at = new Date(event.at);
  return (
    <li className="py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <MetaLine items={[
          <span key="actor" className="text-text-secondary">{describeMomentumActor(event)}</span>,
          <time key="at" dateTime={event.at} title={at.toLocaleString()}>{timeAgo(event.at)}</time>,
        ]} />
        {event.sessionId && onSelectSession && (
          <Button size="sm" variant="ghost" className="-mr-2.5 shrink-0" onClick={() => onSelectSession(event.sessionId!)}>
            Open session
          </Button>
        )}
      </div>
      <dl className="mt-1 space-y-1">
        {event.changes.map((change, index) => {
          const described = describeMomentumChange(change);
          return (
            <div key={`${change.field}-${index}`} className="min-w-0">
              <dt className={DS.text.meta}>{described.label}</dt>
              <dd className={cx(DS.text.rowDetail, "line-clamp-3 break-words")} title={described.value}>{described.value}</dd>
              {described.note && <dd className={DS.text.meta}>{described.note}</dd>}
              {described.previous && (
                <dd className={cx(DS.text.meta, "line-clamp-2 break-words")} title={described.previous}>Was: {described.previous}</dd>
              )}
            </div>
          );
        })}
      </dl>
    </li>
  );
}

/**
 * Who changed a task's "where things stand" fields and when. One closed line with the latest
 * change; it opens to the recent history. Standalone mode wraps it in its own group for archived
 * tasks, whose momentum editor is hidden.
 */
export default function TaskMomentumHistory({
  taskId,
  onSelectSession,
  standalone = false,
}: {
  taskId: string;
  onSelectSession?: (sessionId: string) => void;
  standalone?: boolean;
}) {
  const query = useQuery({
    queryKey: queryKeys.taskMomentumEvents(taskId),
    queryFn: ({ signal }) => fetchTaskMomentumEvents(taskId, { signal, limit: TASK_MOMENTUM_HISTORY_LIMIT }),
    refetchOnWindowFocus: false,
  });
  const events = query.data ?? [];
  const latest = events[0];

  if (query.isError) {
    const hint = <EmptyHint className={standalone ? undefined : "mt-2"}>Change history could not be loaded.</EmptyHint>;
    return standalone ? <Section label="Where things stood" surface>{hint}</Section> : hint;
  }
  if (!latest) {
    if (standalone || query.isPending) return null;
    return <EmptyHint className="mt-2">No recorded changes yet.</EmptyHint>;
  }

  const summary = `Changed ${timeAgo(latest.at)} by ${describeMomentumActor(latest)}`;
  const row = (
    <DisclosureRow
      className={standalone ? undefined : "mt-1"}
      label={<span className="truncate">{summary}</span>}
      title={summary}
      meta={events.length > 1 ? `${events.length}${events.length >= TASK_MOMENTUM_HISTORY_LIMIT ? "+" : ""} updates` : undefined}
    >
      <ol className={DS.surface.divided} aria-label="Change history">
        {events.map((event) => (
          <MomentumEventRow key={event.id} event={event} onSelectSession={onSelectSession} />
        ))}
      </ol>
      {events.length >= TASK_MOMENTUM_HISTORY_LIMIT && (
        <EmptyHint className="pt-1">Showing the latest {TASK_MOMENTUM_HISTORY_LIMIT} updates.</EmptyHint>
      )}
    </DisclosureRow>
  );

  return standalone ? <Section label="Where things stood" surface>{row}</Section> : row;
}
