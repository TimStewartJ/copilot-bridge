import type { QueryClient } from "@tanstack/react-query";
import {
  deleteSession as deleteSessionApi,
  sendChatMessage as sendChatMessageApi,
  type Attachment,
  type Session,
  type Task,
} from "./api";
import { queryKeys } from "./queryClient";
import type { SendMode } from "../shared/send-mode.js";

type DeleteSession = (sessionId: string) => Promise<void>;
type SendChatMessage = (
  sessionId: string,
  prompt: string,
  attachments?: Attachment[],
  mode?: SendMode,
  options?: { waitForDelivery?: boolean },
) => Promise<unknown>;
type QueryInvalidator = () => Promise<unknown>;
type SelectedTaskUpdater = (updater: (task: Task | null) => Task | null) => void;

export interface FailedFirstSendSessionCleanupOptions {
  sessionId: string;
  taskId?: string;
  queryClient: QueryClient;
  clearPendingPromptSession: (sessionId: string) => void;
  clearDraft?: (composerKey: string) => void;
  clearDraftSessionBySessionId?: (sessionId: string) => void;
  clearLastViewedSession?: (sessionId: string) => void;
  clearLastActiveQuickChat?: (sessionId: string) => void;
  updateSelectedTask?: SelectedTaskUpdater;
  deleteSession?: DeleteSession;
  invalidateAllSessionQueries?: QueryInvalidator;
  invalidateTasks?: QueryInvalidator;
  logger?: Pick<Console, "error">;
}

export interface SendMaterializedFirstPromptOptions {
  sessionId: string;
  prompt: string;
  attachments?: Attachment[];
  mode?: SendMode;
  sendChatMessage?: SendChatMessage;
  onRejected?: (error: unknown) => void | Promise<void>;
  logger?: Pick<Console, "error">;
}

function removeSessionFromTask(task: Task, sessionId: string, taskId: string): Task {
  if (task.id !== taskId || !task.sessionIds.includes(sessionId)) return task;
  return {
    ...task,
    sessionIds: task.sessionIds.filter((candidate) => candidate !== sessionId),
  };
}

export function removeFailedFirstSendSessionFromCache(
  queryClient: QueryClient,
  sessionId: string,
  taskId?: string,
  updateSelectedTask?: SelectedTaskUpdater,
): void {
  queryClient.setQueriesData<Session[]>({ queryKey: ["sessions"] }, (prev) => {
    if (!prev?.some((session) => session.sessionId === sessionId)) return prev;
    return prev.filter((session) => session.sessionId !== sessionId);
  });

  if (!taskId) return;

  queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) => {
    if (!prev?.some((task) => task.id === taskId && task.sessionIds.includes(sessionId))) return prev;
    return prev.map((task) => removeSessionFromTask(task, sessionId, taskId));
  });

  updateSelectedTask?.((prev) => (prev ? removeSessionFromTask(prev, sessionId, taskId) : prev));
}

export async function cleanupFailedFirstSendSession({
  sessionId,
  taskId,
  queryClient,
  clearPendingPromptSession,
  clearDraft,
  clearDraftSessionBySessionId,
  clearLastViewedSession,
  clearLastActiveQuickChat,
  updateSelectedTask,
  deleteSession = deleteSessionApi,
  invalidateAllSessionQueries,
  invalidateTasks,
  logger = console,
}: FailedFirstSendSessionCleanupOptions): Promise<void> {
  clearPendingPromptSession(sessionId);
  clearDraft?.(sessionId);
  clearDraftSessionBySessionId?.(sessionId);
  clearLastViewedSession?.(sessionId);
  clearLastActiveQuickChat?.(sessionId);
  removeFailedFirstSendSessionFromCache(queryClient, sessionId, taskId, updateSelectedTask);

  try {
    await deleteSession(sessionId);
  } catch (error) {
    logger.error("Failed to clean up unsent session:", error);
    return;
  }

  await Promise.all([
    invalidateAllSessionQueries?.() ?? Promise.resolve(),
    taskId ? (invalidateTasks?.() ?? Promise.resolve()) : Promise.resolve(),
  ]).catch((error) => {
    logger.error("Failed to refresh after cleaning up unsent session:", error);
  });
}

export async function sendMaterializedFirstPrompt({
  sessionId,
  prompt,
  attachments,
  mode,
  sendChatMessage = sendChatMessageApi,
  onRejected,
  logger = console,
}: SendMaterializedFirstPromptOptions): Promise<void> {
  try {
    await sendChatMessage(sessionId, prompt, attachments, mode, { waitForDelivery: true });
  } catch (error) {
    try {
      await onRejected?.(error);
    } catch (cleanupError) {
      logger.error("Failed to handle rejected first send:", cleanupError);
    }
    throw error;
  }
}
