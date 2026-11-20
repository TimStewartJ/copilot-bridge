import { Link, useParams } from "react-router-dom";
import { useModelComparisonQuery } from "../hooks/queries/useModelComparison";
import { useModelsQuery } from "../hooks/queries/useModels";
import { Details, Field, FieldList, Section } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { describeComparisonSetup, judgeRunLabel, judgeVerdict, verdictLabel } from "../lib/model-comparison-display";

/** A pair the user combined or dismissed, kept in Session details once the chat bar is gone. */
export default function ModelComparisonRecord({ sessionId }: { sessionId: string }) {
  const { taskId: routeTaskId } = useParams<{ taskId?: string }>();
  const { data: models } = useModelsQuery();
  const { data: comparison } = useModelComparisonQuery(sessionId);
  const revealed = comparison?.revealed;
  if (!comparison || !revealed || !(comparison.combinedKeep || comparison.dismissed)) return null;

  const name = (model: string) => models?.find((entry) => entry.id === model)?.name ?? model;
  const other = comparison.side === "x" ? "Y" : "X";
  const taskId = routeTaskId ?? comparison.taskId;
  const otherPath = comparison.otherSessionId
    ? (taskId ? `/tasks/${taskId}/sessions/${comparison.otherSessionId}` : `/sessions/${comparison.otherSessionId}`)
    : undefined;
  const judge = revealed.judge;
  const sideValue = (side: "x" | "y") => (
    <>
      {describeComparisonSetup(revealed[side], models)}
      {comparison.side === side && <span className={cx("ml-2", DS.text.meta)}>this chat</span>}
    </>
  );

  return (
    <Section
      label="Model comparison"
      action={otherPath && (
        <Link to={otherPath} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "-mr-2")}>
          Open {other}
        </Link>
      )}
    >
      <FieldList>
        <Field label="X">{sideValue("x")}</Field>
        <Field label="Y">{sideValue("y")}</Field>
        <Field label="Outcome">
          {comparison.combinedKeep ? `Combined, kept ${verdictLabel(comparison.combinedKeep)}` : "Dismissed"}
          {/* A combine also fills `vote`, so it is news only beside a dismiss. */}
          {comparison.dismissed && comparison.vote && <span className={cx("ml-2", DS.text.meta)}>you voted {verdictLabel(comparison.vote)}</span>}
        </Field>
        {judge && <Field label={judge.judgesAsked > 1 ? "Judges" : "Judge"}>{judgeVerdict(judge)}</Field>}
      </FieldList>
      {judge && judge.runs.length > 0 && (
        <Details label="Judges' reasons" className="mt-2">
          <ul className="space-y-2">
            {judge.runs.map((run, index) => (
              <li key={`${run.model}-${index}`} className={DS.text.prose}>
                <span className="text-text-primary">{judgeRunLabel(run, name)}: {verdictLabel(run.winner)}.</span>{" "}
                {run.reason}
              </li>
            ))}
          </ul>
        </Details>
      )}
    </Section>
  );
}
