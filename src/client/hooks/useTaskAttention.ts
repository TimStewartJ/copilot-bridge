import { useEffect, useMemo, useRef } from "react";
import type { Session, Task } from "../api";
import type { TaskOverview, TaskOverviewRow } from "../../shared/task-overview";
import useTaskIndicators, { type TaskIndicator, type TaskSessionSource } from "./useTaskIndicators";
import { useTaskOverviewQuery } from "./queries/useTaskOverview";
import { getTaskActivityDescription, getTaskAttentionSignal, getTaskLeadingGlyph, type TaskRowSignal } from "../task-row-signals";
import type { DsStatusKind } from "../design/tokens";
import { useNow } from "./useNow";

type AttentionTask = Pick<Task, "id" | "title" | "status" | "completedAt" | "muted" | "deferred" | "waitingOn" | "nextTouchAt">;
interface AttentionQuery {
  data?: Pick<TaskOverview, "tasks" | "generatedAt">;
  isError: boolean;
}
interface PreviousReading {
  key: string;
  signal: TaskRowSignal | null;
  updatedAt?: string;
}

function overviewIndicator(row?: TaskOverviewRow): TaskIndicator {
  return {
    busy: (row?.busyCount ?? 0) > 0, busyCount: row?.busyCount ?? 0, stalled: (row?.stalledCount ?? 0) > 0,
    unread: false, unreadCount: 0, needsUserInputCount: row?.inputCount,
    readStateKnown: !row?.sessionId && row?.activity?.sessionIndexKnown === true,
    sessionStateKnown: row?.activity?.sessionIndexKnown === true, lastActivity: row?.lastEngagedAt ?? "",
  };
}

/** Only task-specific uncertainty occupies a task's status slot; a gap in a shared source keeps the last reading. */
export function useTaskAttentionPresentation(
  tasks: readonly AttentionTask[],
  indicators: ReadonlyMap<string, TaskIndicator> | undefined,
  query: AttentionQuery,
) {
  const now = useNow(tasks.some(task => !!task.nextTouchAt), 60_000);
  const previousReadings = useRef(new Map<string, PreviousReading>());
  const projection = useMemo(() => {
    const rows = new Map((query.data?.tasks ?? []).map(row => [row.id, row]));
    const taskSignals = new Map<string, TaskRowSignal | null>();
    const taskGlyphs = new Map<string, DsStatusKind | null>();
    const activityDescriptions = new Map<string, string>();
    const loading = !query.data && !query.isError;
    const nextReadings = new Map<string, PreviousReading>();
    for (const task of tasks) {
      const row = rows.get(task.id);
      const indicator = indicators?.get(task.id) ?? overviewIndicator(row);
      const signal = getTaskAttentionSignal(task, indicator, new Date(now), {
        activity: row?.activity, inputCount: row?.inputCount,
      });
      const issue = row?.activity?.unavailable;
      const expectedPreviewGap = issue?.scope === "source" && issue.expectedInPreview === true;
      const invalidRevisit = !!task.nextTouchAt && !Number.isFinite(Date.parse(task.nextTouchAt));
      const taskProblem = invalidRevisit || issue?.scope === "task";
      const activeTask = task.status === "active" && !task.completedAt;
      let sourceGap = activeTask && (query.isError || loading);
      if (issue?.scope === "source" && !expectedPreviewGap) sourceGap = true;
      if (activeTask && !task.muted && !task.deferred) {
        if (query.data && !row?.activity) sourceGap = true;
        if (indicator.readStateError
          || indicator.readStateKnown === false && !taskProblem && issue?.scope !== "source") sourceGap = true;
        if (indicator.sessionSource?.error || indicator.sessionSource?.loading
          || indicator.sessionStateKnown === false && row?.activity?.sessionIndexKnown !== false && !loading) sourceGap = true;
      }
      const sharedGap = sourceGap || expectedPreviewGap;
      const key = JSON.stringify([task.status, task.completedAt, task.muted, task.deferred, task.waitingOn, task.nextTouchAt]);
      const previous = previousReadings.current.get(task.id);
      const matchingPrevious = previous?.key === key ? previous : undefined;
      let displayed = signal;
      let previousCleared = false;
      if (signal?.kind === "status-unknown" && sharedGap && !taskProblem) {
        if (expectedPreviewGap && !sourceGap) {
          displayed = null;
          previousCleared = true;
        } else {
          const inputCleared = matchingPrevious?.signal?.kind === "needs-input" && indicator.sessionStateKnown === true
            && Math.max(indicator.needsUserInputCount ?? 0, row?.inputCount ?? 0) === 0;
          const replyRead = matchingPrevious?.signal?.kind === "unread" && indicator.readStateKnown === true
            && indicator.sessionStateKnown === true && indicator.unreadCount === 0;
          displayed = matchingPrevious && !inputCleared && !replyRead ? matchingPrevious.signal : null;
          previousCleared = inputCleared || replyRead;
        }
      }
      if (signal?.kind !== "status-unknown" || previousCleared) {
        nextReadings.set(task.id, { key, signal: previousCleared ? null : signal, updatedAt: query.data?.generatedAt });
      } else if (matchingPrevious) nextReadings.set(task.id, matchingPrevious);
      taskSignals.set(task.id, displayed);
      taskGlyphs.set(task.id, getTaskLeadingGlyph(displayed, indicator, row?.activity));
      const description = getTaskActivityDescription(task, indicator, row?.activity);
      activityDescriptions.set(task.id, sharedGap && description === "Task activity unavailable" ? "" : description);
    }
    return { taskSignals, taskGlyphs, activityDescriptions, nextReadings };
  }, [tasks, indicators, query.data, query.isError, now]);
  useEffect(() => { previousReadings.current = projection.nextReadings; }, [projection.nextReadings]);
  return { taskSignals: projection.taskSignals, taskGlyphs: projection.taskGlyphs, activityDescriptions: projection.activityDescriptions };
}

/** Adds server continuation evidence without changing unread state, notifications or task order. */
export function useTaskAttention(
  tasks: Task[],
  sessions: Session[],
  isUnread?: (sessionId: string, activityTime?: string) => boolean,
  activeSessionId?: string | null,
  readStateReady = isUnread !== undefined,
  readStateError?: string,
  sessionSource?: TaskSessionSource,
) {
  const overview = useTaskOverviewQuery(tasks.length > 0);
  const taskIndicators = useTaskIndicators(tasks, sessions, isUnread, activeSessionId, readStateReady, readStateError, sessionSource);
  return { overview, taskIndicators, ...useTaskAttentionPresentation(tasks, taskIndicators, overview) };
}
