import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { isSessionActive, type Session } from "../../api";
import type { VoiceSessionActivity } from "../useBackgroundVoiceJobs";
import type { StatusEvent } from "../../useStatusStream";
import { queryKeys } from "../../queryClient";
import { helmStateQueryKey } from "../../helm/helm-api";
import { archivedEventSessionIds } from "../../../shared/session-archive-event.js";
import { TASK_OVERVIEW_KEY } from "./useTaskOverview";
import { patchSessionQueryData } from "./useSessions";

export function getVoiceSessionIntent(status: VoiceSessionActivity["status"]): string {
  if (status === "uploading") return "Uploading voice input";
  if (status === "sending") return "Sending voice message";
  return "Processing voice input";
}

function isVoiceSessionIntent(intent: string): boolean {
  return intent === "Uploading voice input"
    || intent === "Processing voice input"
    || intent === "Sending voice message";
}

export function projectVoiceSessionActivity(queryClient: QueryClient, activity: VoiceSessionActivity): void {
  const intent = getVoiceSessionIntent(activity.status);
  patchSessionQueryData(queryClient, [activity.sessionId], (session: Session): Partial<Session> => {
    const existingIntent = session.intentText?.trim() ?? "";
    const preserveExistingIntent = isSessionActive(session) && existingIntent.length > 0 && !isVoiceSessionIntent(existingIntent);
    return {
      runState: session.runState === "stalled" ? "stalled" : "busy",
      intentText: preserveExistingIntent ? session.intentText : intent,
    };
  });
}

export interface SessionEventEffects {
  queries: Pick<QueryClient, "invalidateQueries">;
  isHelmSession(sessionId: string): boolean;
  onBusy(sessionId?: string): void;
  onIdle(sessionId?: string): void;
  onArchived(sessionIds: readonly string[], archived: boolean): void;
  onHistoryTruncated(sessionId?: string): void;
}

/** Projects server lifecycle events into session queries; transcript streaming stays separate. */
export function projectSessionEvent(
  queryClient: QueryClient,
  event: StatusEvent,
  effects: SessionEventEffects,
): boolean {
  const sessionId = "sessionId" in event ? event.sessionId : undefined;
  const isHelmSession = !!sessionId && effects.isHelmSession(sessionId);
  const activeSessionsKey = queryKeys.sessions({ includeArchived: false });
  const patch = (changes: Partial<Session>) => {
    if (sessionId) patchSessionQueryData(queryClient, [sessionId], changes);
  };
  const refetch = (...keys: QueryKey[]) => {
    for (const queryKey of keys) void effects.queries.invalidateQueries({ queryKey });
  };

  switch (event.type) {
    case "session:busy":
      patch({ runState: "busy" });
      effects.onBusy(sessionId);
      refetch(queryKeys.dashboard);
      break;
    case "session:stalled":
      patch({ runState: "stalled" });
      refetch(queryKeys.dashboard);
      break;
    case "session:mode":
      patch({ agentMode: event.agentMode === "autopilot" ? "autopilot" : null });
      break;
    case "session:idle":
      effects.onIdle(sessionId);
      patch({ runState: "idle", intentText: null });
      if (isHelmSession) refetch(helmStateQueryKey);
      refetch(activeSessionsKey, queryKeys.dashboard);
      break;
    case "session:intent":
      patch({ intentText: event.intent ?? null });
      break;
    case "session:title":
      if (event.title) {
        patch({ summary: event.title });
        if (isHelmSession) refetch(helmStateQueryKey);
      }
      refetch(queryKeys.dashboard);
      break;
    case "session:archived": {
      const ids = archivedEventSessionIds(event);
      if (ids.length > 0 && typeof event.archived === "boolean") {
        effects.onArchived(ids, event.archived);
        patchSessionQueryData(queryClient, ids, { archived: event.archived });
      }
      refetch(["sessions"], queryKeys.taskArchivedSessionsRoot, queryKeys.tasks, TASK_OVERVIEW_KEY);
      break;
    }
    case "session:agents":
      if (event.backgroundAgents) patch({ backgroundAgents: event.backgroundAgents });
      refetch(TASK_OVERVIEW_KEY);
      break;
    case "session:continuation":
      refetch(TASK_OVERVIEW_KEY);
      break;
    case "sessions:changed":
      refetch(sessionId ? activeSessionsKey : ["sessions"], queryKeys.dashboard);
      break;
    case "session:user-input": {
      const pendingUserInputCount = event.pendingUserInputCount ?? 0;
      patch({ pendingUserInputCount, needsUserInput: event.needsUserInput ?? pendingUserInputCount > 0 });
      refetch(queryKeys.dashboard);
      break;
    }
    case "session:defer-summary":
      if (sessionId && event.deferSummary) {
        patch({ deferSummary: event.deferSummary });
        refetch(queryKeys.sessionDefers(sessionId), TASK_OVERVIEW_KEY);
      }
      break;
    case "session:history-truncated":
      effects.onHistoryTruncated(sessionId);
      break;
    case "schedule:triggered":
      refetch(activeSessionsKey, queryKeys.tasks, TASK_OVERVIEW_KEY);
      if (event.taskId) refetch(queryKeys.task(event.taskId));
      if (event.scheduleId) refetch(queryKeys.scheduleSessions(event.scheduleId));
      effects.onBusy(sessionId);
      break;
    default:
      return false;
  }
  return true;
}
