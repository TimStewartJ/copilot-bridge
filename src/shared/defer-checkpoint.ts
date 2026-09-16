export const DEFER_CHECKPOINT_MAX_BYTES = 16 * 1024;

/** Private JSON state a recurring defer worker hands to its next occurrence. */
export type DeferCheckpoint = Record<string, unknown>;
