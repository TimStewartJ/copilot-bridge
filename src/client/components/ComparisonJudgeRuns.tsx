import { DS, cx } from "../design/tokens";
import { findingLabel, judgeRunLabel, verdictLabel, type ComparisonJudgeView } from "../lib/model-comparison-display";

/** Each judge run's pick, reason and findings, as the chat bar and Session details show them. */
export default function ComparisonJudgeRuns({ judge, name }: { judge: ComparisonJudgeView; name: (model: string) => string }) {
  return (
    <ul className="space-y-2">
      {judge.runs.map((run, index) => (
        <li key={`${run.model}-${index}`} className={DS.text.prose}>
          <span className="text-text-primary">{judgeRunLabel(run, name)}: {verdictLabel(run.winner)}.</span>{" "}
          {run.reason}
          {run.findings && run.findings.length > 0 && (
            <ul className="mt-1 space-y-1">
              {run.findings.map((finding, findingIndex) => (
                <li key={findingIndex}>
                  <span className={cx("font-medium", finding.kind === "wrong" ? DS.tone.warning : "text-text-primary")}>
                    {findingLabel(finding)}:
                  </span>{" "}
                  {finding.text}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
