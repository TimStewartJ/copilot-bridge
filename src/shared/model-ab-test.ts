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
  /** Up to two judge models chosen by hand; empty or missing picks them from the catalog. */
  judges?: string[];
}

/** How many judges score each pair; each scores it in both orders. */
export const MODEL_COMPARISON_JUDGE_COUNT = 2;

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

/** One judge's scoring of the pair in one order. */
export interface ModelComparisonJudgeRun {
  model: string;
  /** False when the judge's maker also made one of the arms. */
  otherFamily: boolean;
  /** The arm shown as Response 1; missing on verdicts from before both orders were scored. */
  firstArm?: ModelAbTestArm;
  winner: ModelComparisonVerdict;
  scores: Record<ModelAbTestArm, ModelComparisonScores>;
  /** The judge's own words, shown as written. */
  reason: string;
}

/** An arm wins only when every judge picked it in both orders; any disagreement is a split. */
export type ModelComparisonPanelVerdict = ModelComparisonVerdict | "split";

export interface ModelComparisonJudgement {
  verdict: ModelComparisonPanelVerdict;
  runs: ModelComparisonJudgeRun[];
  /** Judges asked; fewer counted when one could not score both orders. */
  judgesAsked: number;
  /** Judges whose two orders both came back, the ones the verdict counts. */
  judgesCounted: number;
  judgedAt?: string;
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
  /** The user closed the pair without combining. */
  dismissed?: boolean;
  /** Whose model to carry on with by default: the user's vote. */
  suggestedKeep?: ModelComparisonSide;
  /** The task the pair's chats belong to, so either opens inside it. */
  taskId?: string;
  vote?: ModelComparisonSide | "tie";
  revealed?: {
    x: ModelAbTestSetup;
    y: ModelAbTestSetup;
    judge?: {
      verdict: ModelComparisonSide | "tie" | "split";
      judgesAsked: number;
      judgesCounted: number;
      runs: Array<{ model: string; winner: ModelComparisonSide | "tie"; reason: string; firstSide?: ModelComparisonSide }>;
    };
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
  /** Pairs the judges disagreed on and the user did not vote. */
  splits: number;
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
  winner?: ModelComparisonPanelVerdict;
  decidedBy?: "user" | "judge";
  reason?: string;
  failure?: string;
}

/** A judge as the report shows it: who would judge a pair now. */
export interface ModelAbTestJudge {
  model: string;
  pinned: boolean;
  otherFamily: boolean;
}

/** How often a judge model's verdict matched the user's vote, over pairs the user voted on. */
export interface ModelAbTestJudgeAgreement {
  model: string;
  votes: number;
  agreed: number;
}

export interface ModelAbTestRejudgeProgress {
  running: boolean;
  total: number;
  done: number;
  /** Pairs left as they were: a chat's log is gone, or the judges gave no usable verdict. */
  skipped: number;
}

export interface ModelAbTestReport {
  /** When the reported test began; null when no test has run. */
  startedAt: string | null;
  pairs: number;
  pending: number;
  unusable: number;
  arms: ModelAbTestArmReport[];
  recent: ModelAbTestRecentPair[];
  judges: ModelAbTestJudge[];
  agreement: ModelAbTestJudgeAgreement[];
  rejudge?: ModelAbTestRejudgeProgress;
}
