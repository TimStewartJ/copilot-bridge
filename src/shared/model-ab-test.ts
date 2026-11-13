import type { CopilotContextTier } from "./copilot-context.js";
import type { ModelPresetSlot } from "./model-presets.js";

/**
 * A model A/B test (Settings › Models). While it is on, each new chat and each scheduled run that
 * would follow New chats starts on tier A or tier B at random, and the Bridge records which one, so
 * the two can be compared on the same kind of work. A chat started on a model the user picked, and a
 * schedule with its own tier, are left out.
 */
export interface ModelAbTestSettings {
  enabled: boolean;
  a: ModelPresetSlot;
  b: ModelPresetSlot;
  /**
   * When the current test began. The server sets it when the test is turned on or what an arm runs
   * changes, and keeps it when the test is turned off so its results stay readable.
   */
  startedAt?: string;
}

export type ModelAbTestArm = "a" | "b";

export const MODEL_AB_TEST_ARMS: readonly ModelAbTestArm[] = ["a", "b"];

/** Standard against Deep, the comparison the test was built for. */
export const DEFAULT_MODEL_AB_TEST_TIERS: Readonly<Record<ModelAbTestArm, ModelPresetSlot>> = {
  a: "preset2",
  b: "preset3",
};

export interface ModelAbTestArmReport {
  arm: ModelAbTestArm;
  tier: ModelPresetSlot;
  /** What the arm's chats started on; a test restarts when that changes, so there is one. */
  setup?: { model: string; reasoningEffort?: string; contextTier?: CopilotContextTier };
  chats: number;
  scheduledRuns: number;
  /** Chats whose model the user changed after it started. */
  switched: number;
  /** Chats whose cost is recorded so far; the runtime records it when a chat is put away. */
  meteredSessions: number;
  meteredAiCredits: number;
}

export interface ModelAbTestReport {
  /** When the reported test began; null when no test has run. */
  startedAt: string | null;
  arms: ModelAbTestArmReport[];
}
