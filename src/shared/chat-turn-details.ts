export interface ChatTurnModelUsage {
  model: string;
  displayName?: string;
  requests: number;
  meteredRequests: number;
  meteredAiCredits: number;
}

export interface ChatTurnPhase {
  model: string;
  label: string;
  durationMs?: number;
  outcome?: string;
  note?: string;
  replacedAnswer?: string;
  final: boolean;
}

export interface ChatTurnDetails {
  sourceMessageId: string;
  durationMs?: number;
  finalModel?: string;
  models: ChatTurnModelUsage[];
  phases?: ChatTurnPhase[];
}
