import type { ModelInfo } from "../api";
import type { ModelAbTestSetup, ModelComparisonSide, ModelComparisonView } from "../../shared/model-ab-test.js";
import { formatReasoningEffortLabel } from "../reasoning-effort";

export type ComparisonJudgeView = NonNullable<NonNullable<ModelComparisonView["revealed"]>["judge"]>;

export function verdictLabel(verdict: ModelComparisonSide | "tie"): string {
  return verdict === "tie" ? "tie" : verdict.toUpperCase();
}

/** "Y", "split", or "X (2 of 3)" when some judges' runs didn't count. */
export function judgeVerdict(judge: ComparisonJudgeView): string {
  return `${judge.verdict === "split" ? "split" : verdictLabel(judge.verdict)}${countedNote(judge)}`;
}

function countedNote(judge: ComparisonJudgeView): string {
  return judge.judgesCounted < judge.judgesAsked ? ` (${judge.judgesCounted} of ${judge.judgesAsked})` : "";
}

/** "Judges: Y", "Judges split", or "Judge: X" for a verdict from before panels. */
export function judgeSummary(judge: ComparisonJudgeView): string {
  if (judge.verdict === "split") return `Judges split${countedNote(judge)}`;
  return `${judge.judgesAsked > 1 ? "Judges" : "Judge"}: ${verdictLabel(judge.verdict)}${countedNote(judge)}`;
}

/** "GPT-6 (X first)": a judge's model and which side it read first. */
export function judgeRunLabel(run: ComparisonJudgeView["runs"][number], name: (model: string) => string): string {
  return `${name(run.model)}${run.firstSide ? ` (${run.firstSide.toUpperCase()} first)` : ""}`;
}

type ComparisonFindingView = NonNullable<ComparisonJudgeView["runs"][number]["findings"]>[number];

/** "Only X" for what only X found, "X wrong" for an X claim a judge checked and found false. */
export function findingLabel(finding: ComparisonFindingView): string {
  const side = finding.side.toUpperCase();
  return finding.kind === "only" ? `Only ${side}` : `${side} wrong`;
}

/** "Claude Opus 5.5 · High · long context" */
export function describeComparisonSetup(setup: ModelAbTestSetup, models: readonly ModelInfo[] | undefined): string {
  const model = models?.find((entry) => entry.id === setup.model);
  return [
    model?.name ?? setup.model,
    formatReasoningEffortLabel(setup.reasoningEffort, model),
    setup.contextTier === "long_context" ? "long context" : undefined,
  ].filter(Boolean).join(" · ");
}
