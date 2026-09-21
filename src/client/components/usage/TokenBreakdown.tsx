import type { CopilotUsageTotals } from "../../api";
import { Field, FieldList } from "../../design/primitives";
import { formatUsageNumber } from "../../lib/usage-presentation";

/** Shared token vocabulary for account history, tasks, and the current session. */
export default function TokenBreakdown({ totals }: { totals: Partial<CopilotUsageTotals> }) {
  const values = [
    { label: "Input", value: totals.inputTokens },
    { label: "Uncached input", value: totals.uncachedInputTokens },
    { label: "Cache read", value: totals.cacheReadTokens },
    { label: "Cache write", value: totals.cacheWriteTokens },
    { label: "Output", value: totals.outputTokens },
    { label: "Reasoning", value: totals.reasoningTokens },
    { label: "Requests", value: totals.requests },
  ];

  return (
    <FieldList>
      {values.map(({ label, value }) => value === undefined ? null : (
        <Field key={label} label={label}>
          <span className="tabular-nums">{formatUsageNumber(value)}</span>
          {label === "Reasoning" && <span className="ml-2 text-xs text-text-secondary">included in output</span>}
        </Field>
      ))}
    </FieldList>
  );
}
