import type { CopilotContextTier } from "./copilot-context.js";
import type { ModelRoleChoice } from "./model-roles.js";

/** A tier, or a model of its own so a model can be tried before it becomes a tier. */
export type ModelAbTestArmChoice = ModelRoleChoice;

/** When on, each chat the user starts also runs on the other arm, and the two are compared. */
export interface ModelAbTestSettings {
  enabled: boolean;
  a: ModelAbTestArmChoice;
  b: ModelAbTestArmChoice;
  /** Reset when the test is turned on or an arm changes; kept when off so results stay readable. */
  startedAt?: string;
}

export type ModelAbTestArm = "a" | "b";

export const MODEL_AB_TEST_ARMS: readonly ModelAbTestArm[] = ["a", "b"];

/** Standard against Deep. */
export const DEFAULT_MODEL_AB_TEST_ARMS: Readonly<Record<ModelAbTestArm, ModelAbTestArmChoice>> = {
  a: { tier: "preset2" },
  b: { tier: "preset3" },
};

/** What an arm ran on: model, effort and context as the chat was created. */
export interface ModelAbTestSetup {
  model: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

/** The pair's two chats: X is the one the user started, Y runs the same first message. */
export type ModelComparisonSide = "x" | "y";

export type ModelComparisonVerdict = ModelAbTestArm | "tie";

export type ModelComparisonStatus =
  /** Created; waiting for the chat's first message. */
  | "awaiting_prompt"
  /** Starting Y and sending it the message. */
  | "starting"
  /** Both chats are on their first turn. */
  | "running"
  | "judging"
  | "judged"
  /** A first turn was steered, stopped or never ended, so the pair is not comparable. */
  | "incomplete"
  | "failed";

/** One side's first turn, measured from its log. */
export interface ModelComparisonTurnMetrics {
  durationMs: number;
  toolCalls: number;
  /** Metered AI credits of the turn's requests, when the runtime recorded them. */
  aiCredits?: number;
}

export type ModelComparisonCriterion = "outcome" | "correctness" | "efficiency" | "clarity";

export const MODEL_COMPARISON_CRITERIA: readonly ModelComparisonCriterion[] = ["outcome", "correctness", "efficiency", "clarity"];

export type ModelComparisonScores = Record<ModelComparisonCriterion, number>;

export interface ModelComparisonJudgement {
  model: string;
  /** False when no model from a third family was set up, so the judge shares one with an arm. */
  otherFamily: boolean;
  winner: ModelComparisonVerdict;
  scores: Record<ModelAbTestArm, ModelComparisonScores>;
  /** The judge's own words, shown as written. */
  reason: string;
}

/** A pair as one of its chats sees it; models are named once the user voted or it is over. */
export interface ModelComparisonView {
  id: string;
  side: ModelComparisonSide;
  otherSessionId?: string;
  status: ModelComparisonStatus;
  /** Both chats ran the message and the user has not voted yet. */
  votable: boolean;
  /** Y's answer can still be handed to X, to carry on in X alone. */
  combinable: boolean;
  /** Whose model X carried on with, once combined. */
  combinedKeep?: ModelComparisonSide;
  /** Whose model to carry on with by default: the user's vote, else the judge's. */
  suggestedKeep?: ModelComparisonSide;
  /** The task the pair's chats belong to, so either opens inside it. */
  taskId?: string;
  vote?: ModelComparisonSide | "tie";
  revealed?: {
    x: ModelAbTestSetup;
    y: ModelAbTestSetup;
    judge?: { winner: ModelComparisonSide | "tie"; reason: string; model: string };
  };
  failure?: string;
}

export interface ModelAbTestArmReport {
  arm: ModelAbTestArm;
  choice: ModelAbTestArmChoice;
  /** What the arm's chats ran on; a test restarts when that changes, so there is one. */
  setup?: ModelAbTestSetup;
  /** Pairs the judge or the user decided. */
  decided: number;
  wins: number;
  ties: number;
  /** Wins by the user's vote alone; the rest are the judge's. */
  userWins: number;
  medianDurationMs?: number;
  medianAiCredits?: number;
}

export interface ModelAbTestRecentPair {
  id: string;
  mainSessionId: string;
  twinSessionId?: string;
  status: ModelComparisonStatus;
  createdAt: string;
  winner?: ModelComparisonVerdict;
  decidedBy?: "user" | "judge";
  reason?: string;
  failure?: string;
}

export interface ModelAbTestReport {
  /** When the reported test began; null when no test has run. */
  startedAt: string | null;
  pairs: number;
  pending: number;
  unusable: number;
  arms: ModelAbTestArmReport[];
  recent: ModelAbTestRecentPair[];
}
