import type { CopilotContextTier } from "./copilot-context.js";

/** How many chats that are not archived use one model. */
export interface SessionModelUsageEntry {
  model: string;
  sessionCount: number;
  /** Chats with a turn or another operation in flight when they were counted; a move skips them. */
  busyCount: number;
}

export interface SessionModelUsage {
  scannedAt: string;
  /** Chats that are not archived. */
  sessionCount: number;
  /** Chats whose model could not be read from the runtime or the event log. */
  unknownCount: number;
  /** Most used first. */
  models: SessionModelUsageEntry[];
}

export interface SessionModelMoveRequest {
  fromModel: string;
  toModel: string;
  /** Omitted: each chat keeps its effort, or the nearest one the new model supports. */
  reasoningEffort?: string;
  /** Omitted: a chat keeps as large a window as it has, if the new model offers one. */
  contextTier?: CopilotContextTier;
  /** Compact a chat too big for the new model, then move it; off leaves such a chat alone. */
  compact?: boolean;
  /** Limits the move to these chats, for example to put back the chats an earlier move changed. */
  sessionIds?: string[];
  /** Report what would move without changing anything. */
  dryRun?: boolean;
}

export interface SessionModelMoveCandidate {
  sessionId: string;
  title?: string;
  busy: boolean;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

/** The answer to a dry run. */
export interface SessionModelMovePlan {
  dryRun: true;
  fromModel: string;
  toModel: string;
  sessions: SessionModelMoveCandidate[];
}

export const SESSION_MODEL_MOVE_OUTCOMES = ["moved", "busy", "needs-compaction", "changed", "failed"] as const;

/** busy: mid-turn, left alone; needs-compaction: too big, not asked; changed: off the old model. */
export type SessionModelMoveOutcome = typeof SESSION_MODEL_MOVE_OUTCOMES[number];

export interface SessionModelMoveResult {
  sessionId: string;
  title?: string;
  outcome: SessionModelMoveOutcome;
  detail?: string;
  /** What the chat used before it moved, so a script can put it back. */
  previousReasoningEffort?: string;
  previousContextTier?: CopilotContextTier;
}

/** cancelled: on request; stopped: after repeated failures; both leave the rest untouched. */
export type SessionModelMoveStatus = "running" | "completed" | "cancelled" | "stopped";

export interface SessionModelMoveJob {
  id: string;
  status: SessionModelMoveStatus;
  fromModel: string;
  toModel: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  compact: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Chats on the old model when the move started. */
  total: number;
  /** Chats that have had their turn. */
  processed: number;
  counts: Record<SessionModelMoveOutcome, number>;
  currentSessionId?: string;
  cancelRequested: boolean;
  /** Why a `stopped` move gave up. */
  stopReason?: string;
  results: SessionModelMoveResult[];
}

export interface SessionModelMoveState {
  /** The running move, or the last one since the server started. */
  job: SessionModelMoveJob | null;
}

export function isSessionModelMoveFinished(status: SessionModelMoveStatus): boolean {
  return status !== "running";
}
