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
  /** Applied to every moved chat. Omitted: each chat keeps its effort, or the nearest one the new model supports. */
  reasoningEffort?: string;
  /** Applied to every moved chat. Omitted: a chat on long context keeps it when the new model offers it. */
  contextTier?: CopilotContextTier;
  /** Compact a conversation that does not fit the new model, then move it. Off: such a chat is left as it is. */
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

/**
 * What happened to one chat:
 * - `moved`: it is on the new model.
 * - `busy`: a turn or another operation was in flight, so it was left alone.
 * - `needs-compaction`: its conversation does not fit the new model and compaction was not asked for.
 * - `changed`: it was no longer on the old model when its turn came.
 * - `failed`: the switch raised an error or the runtime did not apply it.
 */
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

/**
 * - `running`: chats are still being switched, one at a time.
 * - `completed`: every chat had its turn.
 * - `cancelled`: stopped on request; the rest were not touched.
 * - `stopped`: gave up after several chats in a row failed; the rest were not touched.
 */
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
