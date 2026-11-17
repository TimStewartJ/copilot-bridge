/** Opt-in features, off while unset; removing one means its field, Settings control and one use. */
export interface ExperimentalSettings {
  /** Overrides Fusion's per-step prompt-token limit (compaction follows); see copilot-fusion.ts. */
  fusionContextTokens?: number;
}

/** Fusion's own limit at High and Max; a smaller override would only compact sooner. */
export const FUSION_CONTEXT_TOKENS_MIN = 128_000;
export const FUSION_CONTEXT_TOKENS_MAX = 1_000_000;

/** Kept below what Claude refuses: the runtime undercounts Claude prompts by about a third. */
export const FUSION_CONTEXT_TOKEN_CHOICES: readonly number[] = [256_000, 400_000, 600_000];
