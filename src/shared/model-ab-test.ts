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
  /** What Copilot's trajectory classifiers measured on the arm's graded chats; absent before any grading. */
  grades?: ModelAbTestArmGrades;
}

/** Why a chat in the test has no grade: no log, a log too big to send, a log the runtime rejected, or a failed call. */
export type ModelAbTestGradeSkipReason = "missing" | "too-large" | "invalid" | "error";

/**
 * How many of an arm's graded chats got one label value from one classifier. Classifier, label and
 * value names come from the Copilot runtime and are open strings: show them as text.
 */
export interface ModelAbTestLabelCount {
  classifier: string;
  /** The unit the classifier's counts are taken over: session, task, turn or prompt. */
  scope: string;
  label: string;
  value: string;
  count: number;
}

export interface ModelAbTestArmGrades {
  /** Chats graded; individual classifiers may still have declined or failed on them. */
  graded: number;
  /** Chats that could not be graded, by reason. */
  notGraded: Partial<Record<ModelAbTestGradeSkipReason, number>>;
  labels: ModelAbTestLabelCount[];
  /** Input and output tokens the judge models used on this arm. */
  judgeTokens: number;
}

/** The grading run (POST /api/model-ab-test/grade). Kept in memory: a restart ends a run, saved grades stay. */
export interface ModelAbTestGradingStatus {
  running: boolean;
  /** Chats the current or last run set out to grade, and how many it has finished. */
  total: number;
  done: number;
  /** Chats in the test with no grade yet, or whose last attempt failed. */
  ungraded: number;
  finishedAt?: string;
}

export interface ModelAbTestReport {
  /** When the reported test began; null when no test has run. */
  startedAt: string | null;
  arms: ModelAbTestArmReport[];
  grading?: ModelAbTestGradingStatus;
}
