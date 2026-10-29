/**
 * Opt-in features that may change or go away. Each is off while unset, so removing one means
 * deleting its field here, its control in Settings and the one place that applies it.
 */
export interface ExperimentalSettings {
  /**
   * Prompt-token limit for chats on Copilot Fusion, in place of the runtime's own. Every Fusion
   * step may then use up to this many tokens on whichever model it picks, and compaction moves
   * with it. The Copilot backend applies it (`agent-backend/copilot-fusion.ts`).
   */
  fusionContextTokens?: number;
}

/** Fusion's own limit at High and Max; a smaller override would only compact sooner. */
export const FUSION_CONTEXT_TOKENS_MIN = 128_000;
export const FUSION_CONTEXT_TOKENS_MAX = 1_000_000;

/**
 * The sizes Settings offers. The runtime counts a Claude prompt about a third lower than Anthropic
 * does, and Anthropic refuses prompts over about 936K, so a larger limit fails on Claude steps.
 */
export const FUSION_CONTEXT_TOKEN_CHOICES: readonly number[] = [256_000, 400_000, 600_000];
