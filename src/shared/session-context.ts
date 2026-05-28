export type SessionContextCapability = "exact" | "partial" | "unavailable";
export type SessionContextMarkerCapability = "exact" | "marker" | "unavailable";
export type SessionContextSource = "live" | "backfill" | "estimated";
export type SessionContextProvenanceField = "contextWindow" | "tokensUsed" | "tokensRemaining" | "modelUsage";

/**
 * Provider-level capabilities describe what an adapter can generally report.
 * Field provenance describes where one specific value came from. Keep both:
 * a provider may support exact live context usage while an older row only has
 * backfilled model usage, or a future provider may expose estimated values.
 */
export interface SessionContextFieldProvenance {
  source: SessionContextSource;
  confidence: SessionContextCapability;
}

export type SessionContextProvenance = Partial<Record<SessionContextProvenanceField, SessionContextFieldProvenance>>;

export interface SessionContextCapabilities {
  contextWindow: SessionContextCapability;
  modelUsage: SessionContextCapability;
  compaction: SessionContextMarkerCapability;
  truncation: SessionContextMarkerCapability;
}

export type SessionContextAttribution = "turn" | "subagent_turn" | "session_overhead";

export type SessionContextEventType = "context_snapshot" | "compaction" | "truncation" | "shutdown";

export interface SessionContextTokenUsage {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface SessionContextSummary {
  sessionId: string;
  provider: string;
  providerSessionId: string | null;
  updatedAt: string;
  currentModel: string | null;
  latestBridgeTurnId: string | null;
  latestSnapshotAt: string | null;
  contextWindow: number | null;
  tokensUsed: number | null;
  tokensRemaining: number | null;
  usageRatio: number | null;
  modelUsage: SessionContextTokenUsage | null;
  provenance?: SessionContextProvenance | null;
  snapshotCount: number;
  compactionCount: number;
  truncationCount: number;
  shutdownCount: number;
}

export interface SessionContextTurn {
  sessionId: string;
  bridgeTurnId: string;
  provider: string;
  providerSessionId: string | null;
  providerTurnId: string | null;
  attribution: Exclude<SessionContextAttribution, "session_overhead">;
  startedAt: string | null;
  endedAt: string | null;
  latestEventAt: string | null;
  model: string | null;
}

export interface SessionContextEvent {
  id: number;
  sessionId: string;
  provider: string;
  providerSessionId: string | null;
  providerEventId: string | null;
  providerTurnId: string | null;
  bridgeTurnId: string | null;
  attribution: SessionContextAttribution;
  type: SessionContextEventType;
  occurredAt: string;
  model: string | null;
  contextWindow: number | null;
  tokensUsed: number | null;
  tokensRemaining: number | null;
  usageRatio: number | null;
  modelUsage: SessionContextTokenUsage | null;
  provenance?: SessionContextProvenance | null;
  metadata: Record<string, unknown> | null;
}

export interface SessionContextResponse {
  provider: string;
  summary: SessionContextSummary | null;
  turns: SessionContextTurn[];
  events: SessionContextEvent[];
  capabilities: SessionContextCapabilities;
}
