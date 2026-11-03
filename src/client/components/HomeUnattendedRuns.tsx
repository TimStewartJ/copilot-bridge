import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { reviewUnattendedRun, type Session, type UnattendedRun } from "../api";
import { Button, Section } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { haptic } from "../lib/haptics";
import { useSessionsQuery } from "../hooks/queries/useSessions";
import { UNATTENDED_RUNS_KEY, useDismissUnattendedRun, useUnattendedRunsQuery } from "../hooks/queries/useUnattendedRuns";
import { timeAgo } from "../time";

const VISIBLE_ROWS = 5;

/** The chat's own name when the server or the session list knows it, else its task's, else a plain word. */
export function unattendedRunTitle(run: UnattendedRun, sessions?: readonly Session[]): string {
  return run.title || sessions?.find(session => session.sessionId === run.sessionId)?.summary || run.taskTitle || "Chat";
}

function metaLine(run: UnattendedRun): string {
  return [`${run.turnCount} turn${run.turnCount === 1 ? "" : "s"}`, run.origins.join(", "), timeAgo(run.lastAt)]
    .filter(Boolean).join(" · ");
}

interface Props {
  onSelectSession: (id: string, taskId?: string) => void;
}

/** Chats where defers or schedules ran turns while the user was away, until the user writes there again. */
export default function HomeUnattendedRuns({ onSelectSession }: Props) {
  const client = useQueryClient();
  const runs = useUnattendedRunsQuery().data ?? [];
  const sessions = useSessionsQuery(false, { enabled: runs.some(run => !run.title) }).data;
  const dismiss = useDismissUnattendedRun();
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState<string>();
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  if (!runs.length) return null;

  const setError = (sessionId: string, message?: string) => setErrors(current => {
    const { [sessionId]: _removed, ...rest } = current;
    return message ? { ...rest, [sessionId]: message } : rest;
  });
  async function review(run: UnattendedRun) {
    setReviewing(run.sessionId);
    setError(run.sessionId);
    try {
      await reviewUnattendedRun(run.sessionId);
      void client.invalidateQueries({ queryKey: UNATTENDED_RUNS_KEY });
      onSelectSession(run.sessionId, run.taskId);
    } catch (error) {
      haptic("error");
      setError(run.sessionId, error instanceof Error ? error.message : String(error));
    } finally {
      setReviewing(undefined);
    }
  }
  function remove(run: UnattendedRun) {
    setError(run.sessionId);
    dismiss.mutate(run.sessionId, {
      onError: error => { haptic("error"); setError(run.sessionId, error instanceof Error ? error.message : String(error)); },
    });
  }

  const hidden = runs.length - VISIBLE_ROWS;
  const shown = expanded || hidden <= 0 ? runs : runs.slice(0, VISIBLE_ROWS);
  return <Section label="Ran while you were away" count={runs.length} level="page" surface
    action={hidden > 0 ? <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? "Show fewer" : `${hidden} more`}</Button> : undefined}>
    {shown.map(run => {
      const title = unattendedRunTitle(run, sessions), error = errors[run.sessionId];
      return <div key={run.sessionId} className="min-w-0 border-t border-border py-3 first:border-t-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" className={cx(DS.focus, "min-w-0 flex-1 basis-48 rounded-sm text-left")} onClick={() => onSelectSession(run.sessionId, run.taskId)}>
            <span className="block truncate font-semibold text-text-primary">{title}</span>
            {run.taskTitle && run.taskTitle !== title && <span className={cx(DS.text.prose, "block truncate")}>{run.taskTitle}</span>}
            <span className={cx(DS.text.meta, "mt-0.5 block truncate")}>{metaLine(run)}</span>
          </button>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" disabled={reviewing === run.sessionId} onClick={() => void review(run)}>Review</Button>
            <Button size="sm" variant="ghost" onClick={() => remove(run)}>Dismiss</Button>
          </div>
        </div>
        {error && <p role="alert" className={cx("mt-2 text-xs", DS.tone.danger)}>{error}</p>}
      </div>;
    })}
  </Section>;
}
