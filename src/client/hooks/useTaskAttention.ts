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
  data?: Pick<TaskOverview, "tasks" | "sourceErrors" | "generatedAt">;
  isError: boolean;
  error?: Error | null;
}
interface PreviousReading {
  key: string;
  signal: TaskRowSignal | null;
  updatedAt?: string;
}

export interface TaskAttentionHealth {
  state: "loading" | "partial" | "stale" | "unavailable";
  messages: string[];
  affectedTasks: Array<{ id: string; title: string; reason: string }>;
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

/** Source health is reported once per view; only task-specific uncertainty occupies a task's status slot. */
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
    const affectedTasks: TaskAttentionHealth["affectedTasks"] = [];
    const messages = new Set(query.data?.sourceErrors ?? []);
    if (query.isError) messages.add(query.error?.message || "Task activity could not be refreshed.");
    const loading = !query.data && !query.isError;
    let loadingSource = false;
    let failedSource = false;
    let staleSource = false;
    let showingPrevious = false;
    let previousUpdatedAt: string | undefined;
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
      const reasons: string[] = [];
      if (task.status === "active" && !task.completedAt) {
        if (query.isError) reasons.push(query.error?.message || "Task activity could not be refreshed.");
        else if (loading) reasons.push("Loading task activity.");
      }
      if (issue?.scope === "source" && !expectedPreviewGap) reasons.push(issue.reason);
      if (task.status === "active" && !task.completedAt && !task.muted && !task.deferred) {
        if (query.data && !row?.activity) reasons.push("Continuation information has not been loaded.");
        if (indicator.readStateError) {
          reasons.push(`Read status could not be refreshed: ${indicator.readStateError}`);
          failedSource = true;
          staleSource ||= indicator.readStateKnown === true;
        } else if (indicator.readStateKnown === false && !taskProblem && issue?.scope !== "source") {
          reasons.push("Loading conversation read status.");
          loadingSource = true;
        }
        if (indicator.sessionSource?.error) {
          reasons.push(`Conversation status could not be refreshed: ${indicator.sessionSource.error}`);
          failedSource = true;
          staleSource ||= indicator.sessionStateKnown === true;
        } else if (indicator.sessionSource?.loading) {
          reasons.push("Loading conversation status.");
          loadingSource = true;
        } else if (indicator.sessionStateKnown === false && row?.activity?.sessionIndexKnown !== false && !loading) {
          reasons.push("Some conversation status has not been loaded.");
        }
      }
      const sharedGap = reasons.length > 0 || expectedPreviewGap;
      const key = JSON.stringify([task.status, task.completedAt, task.muted, task.deferred, task.waitingOn, task.nextTouchAt]);
      const previous = previousReadings.current.get(task.id);
      const matchingPrevious = previous?.key === key ? previous : undefined;
      let displayed = signal;
      let previousCleared = false;
      if (signal?.kind === "status-unknown" && sharedGap && !taskProblem) {
        if (expectedPreviewGap && reasons.length === 0) {
          displayed = null;
          previousCleared = true;
        } else {
          const inputCleared = matchingPrevious?.signal?.kind === "needs-input" && indicator.sessionStateKnown === true
            && Math.max(indicator.needsUserInputCount ?? 0, row?.inputCount ?? 0) === 0;
          const replyRead = matchingPrevious?.signal?.kind === "unread" && indicator.readStateKnown === true
            && indicator.sessionStateKnown === true && indicator.unreadCount === 0;
          displayed = matchingPrevious && !inputCleared && !replyRead ? matchingPrevious.signal : null;
          previousCleared = inputCleared || replyRead;
          if (matchingPrevious && !inputCleared && !replyRead) {
            showingPrevious = true;
            if (matchingPrevious.updatedAt && (!previousUpdatedAt || matchingPrevious.updatedAt < previousUpdatedAt)) {
              previousUpdatedAt = matchingPrevious.updatedAt;
            }
          }
        }
      }
      if (signal?.kind !== "status-unknown" || previousCleared) {
        nextReadings.set(task.id, { key, signal: previousCleared ? null : signal, updatedAt: query.data?.generatedAt });
      } else if (matchingPrevious) nextReadings.set(task.id, matchingPrevious);
      taskSignals.set(task.id, displayed);
      taskGlyphs.set(task.id, getTaskLeadingGlyph(displayed, indicator, row?.activity));
      const description = getTaskActivityDescription(task, indicator, row?.activity);
      activityDescriptions.set(task.id, sharedGap && description === "Task activity unavailable" ? "" : description);
      if (reasons.length > 0) {
        affectedTasks.push({ id: task.id, title: task.title, reason: [...new Set(reasons)].join(" ") });
        for (const reason of reasons) if (reason !== "Loading task activity." && reason !== "Loading conversation read status."
          && reason !== "Loading conversation status.") messages.add(reason);
      }
    }
    const hasSourceIssue = messages.size > 0 || affectedTasks.length > 0;
    let state: TaskAttentionHealth["state"] = "partial";
    if (showingPrevious || staleSource || query.isError && query.data) state = "stale";
    else if (query.isError || failedSource) state = "unavailable";
    else if (!messages.size && (loading || loadingSource)) state = "loading";
    const updatedAt = previousUpdatedAt ?? (query.isError ? query.data?.generatedAt : undefined);
    const health: TaskAttentionHealth | null = !hasSourceIssue ? null : {
      state,
      messages: [...messages],
      affectedTasks,
      ...(updatedAt ? { updatedAt } : {}),
    };
    return { taskSignals, taskGlyphs, activityDescriptions, health, nextReadings };
  }, [tasks, indicators, query.data, query.isError, query.error, now]);
  useEffect(() => { previousReadings.current = projection.nextReadings; }, [projection.nextReadings]);
  return { taskSignals: projection.taskSignals, taskGlyphs: projection.taskGlyphs, activityDescriptions: projection.activityDescriptions, health: projection.health };
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
