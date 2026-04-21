import type { PendingOrigin } from "../useSessionStream";

export type ExternalSessionWorkAction = "ignore" | "defer" | "reconnect";

export interface ExternalSessionWorkContext {
  sessionId: string | null;
  nextBusySignal: number;
  previousBusySignal: number;
  isStreaming: boolean;
  pendingOrigin: PendingOrigin;
  isRefreshingHistory: boolean;
  isLoadingHistory: boolean;
  isLoadingOlderMessages: boolean;
  isCreatingSession: boolean;
}

export function resolveExternalSessionWorkAction({
  sessionId,
  nextBusySignal,
  previousBusySignal,
  isStreaming,
  pendingOrigin,
  isRefreshingHistory,
  isLoadingHistory,
  isLoadingOlderMessages,
  isCreatingSession,
}: ExternalSessionWorkContext): ExternalSessionWorkAction {
  if (!sessionId || nextBusySignal === previousBusySignal) return "ignore";
  if (isLoadingHistory || isRefreshingHistory || isLoadingOlderMessages || isCreatingSession) return "defer";
  if (isStreaming) return "ignore";
  if (pendingOrigin === "message" || pendingOrigin === "fleet" || pendingOrigin === "reconnect") {
    return "ignore";
  }
  return "reconnect";
}
