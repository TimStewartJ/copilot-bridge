// Settings › Models › A/B test: grading the test's chats with Copilot's trajectory classifiers, and
// the label counts per arm. Classifier, label and value names come from the runtime: shown as text.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startModelAbTestGrading } from "../../api";
import { queryKeys } from "../../queryClient";
import { formatUsageCount, formatUsageNumber } from "../../lib/usage-presentation";
import { Button, MetaLine } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import type {
  ModelAbTestArm,
  ModelAbTestArmGrades,
  ModelAbTestArmReport,
  ModelAbTestGradeSkipReason,
  ModelAbTestReport,
} from "../../../shared/model-ab-test.js";

const SKIP_LABEL: Record<ModelAbTestGradeSkipReason, string> = {
  missing: "no log",
  "too-large": "too large",
  invalid: "log rejected",
  error: "failed",
};

interface GradeTableGroup {
  classifier: string;
  scope: string;
  rows: Array<{ key: string; label: string; value: string; counts: Partial<Record<ModelAbTestArm, number>> }>;
  /** Show only the value when the classifier reports one label. */
  singleLabel: boolean;
}

/** One group per classifier, one row per label value, with each arm's count. */
export function buildGradeTable(arms: readonly ModelAbTestArmReport[]): GradeTableGroup[] {
  const groups = new Map<string, GradeTableGroup>();
  for (const arm of arms) {
    for (const entry of arm.grades?.labels ?? []) {
      let group = groups.get(entry.classifier);
      if (!group) {
        group = { classifier: entry.classifier, scope: entry.scope, rows: [], singleLabel: true };
        groups.set(entry.classifier, group);
      }
      const key = `${entry.label}\u0000${entry.value}`;
      let row = group.rows.find((candidate) => candidate.key === key);
      if (!row) {
        row = { key, label: entry.label, value: entry.value, counts: {} };
        group.rows.push(row);
      }
      row.counts[arm.arm] = (row.counts[arm.arm] ?? 0) + entry.count;
    }
  }
  return [...groups.values()]
    .sort((left, right) => left.classifier.localeCompare(right.classifier))
    .map((group) => ({
      ...group,
      singleLabel: new Set(group.rows.map((row) => row.label)).size === 1,
      rows: group.rows.sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value)),
    }));
}

function describeArmGrades(arm: ModelAbTestArm, grades: ModelAbTestArmGrades | undefined): Array<string | false> {
  if (!grades) return [];
  const notGraded = (Object.entries(grades.notGraded) as Array<[ModelAbTestGradeSkipReason, number]>)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${SKIP_LABEL[reason]}`);
  return [
    `${arm.toUpperCase()}: ${formatUsageCount(grades.graded, "chat")} graded`,
    ...notGraded,
    grades.judgeTokens > 0 && `${formatUsageNumber(grades.judgeTokens)} judge tokens`,
  ];
}

export function ModelAbTestGrading({ report }: { report: ModelAbTestReport }) {
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grading = report.grading;
  if (!grading) return null;
  const graded = report.arms.some((arm) => (arm.grades?.graded ?? 0) > 0 || Object.keys(arm.grades?.notGraded ?? {}).length > 0);
  const regrade = grading.ungraded === 0;
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await startModelAbTestGrading(regrade);
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelAbTest(report.startedAt) });
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setStarting(false);
    }
  };
  const table = buildGradeTable(report.arms);
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {grading.running
          ? <span className={cx(DS.text.meta, DS.motion.live)}>Grading {grading.done} of {grading.total}</span>
          : <Button size="sm" disabled={starting || (regrade && !graded)} onClick={() => { void start(); }}>
            {regrade ? "Grade again" : "Grade chats"}
          </Button>}
        <span className={DS.text.meta}>Copilot's judge models grade each chat, using AI credits.</span>
      </div>
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
      {graded && <MetaLine items={report.arms.flatMap((arm) => describeArmGrades(arm.arm, arm.grades))} />}
      {table.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border-subtle">
                <th scope="col" className={cx(DS.text.sectionLabel, "py-1 pr-3 text-left")}>Classifier</th>
                {report.arms.map((arm) => (
                  <th key={arm.arm} scope="col" className={cx(DS.text.sectionLabel, "w-12 py-1 pl-3 text-right")}>{arm.arm.toUpperCase()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.map((group) => [
                <tr key={group.classifier}>
                  <th scope="rowgroup" colSpan={report.arms.length + 1} className="pt-2 pb-0.5 text-left font-medium text-text-secondary">
                    {group.classifier} <span className={DS.text.meta}>per {group.scope}</span>
                  </th>
                </tr>,
                ...group.rows.map((row) => (
                  <tr key={`${group.classifier}\u0000${row.key}`} className="border-b border-border-subtle last:border-b-0">
                    <td className="py-1 pr-3 pl-3 text-text-muted">{group.singleLabel ? row.value : `${row.label}: ${row.value}`}</td>
                    {report.arms.map((arm) => (
                      <td key={arm.arm} className="py-1 pl-3 text-right tabular-nums text-text-secondary">{row.counts[arm.arm] ?? 0}</td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
