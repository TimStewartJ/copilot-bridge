import { ChevronRight } from "lucide-react";
import type { CopilotUsageCostEstimate, CopilotUsageModelPricingMetadata, CopilotUsageTotals } from "../../api";
import { COPILOT_USAGE_UNATTRIBUTED_MODEL } from "../../../shared/copilot-usage";
import { DS, cx } from "../../design/tokens";
import { Badge, Field, FieldList, Section, StatRow } from "../../design/primitives";
import { describeMeteredCoverage, formatUsageCredits, formatUsageNumber, formatUsageUsd, hasMeteredUsage, meteredCostUsd } from "../../lib/usage-presentation";
import TokenBreakdown from "./TokenBreakdown";

export interface UsageModelDisplayRow extends CopilotUsageTotals, Partial<CopilotUsageCostEstimate>, Partial<CopilotUsageModelPricingMetadata> {
  model: string;
  sessions: number;
  hasCostEstimate?: boolean;
  hasUnpricedUsage?: boolean;
}

/** A readable model list at any column width; the old table's accounting fields remain one click away. */
export default function UsageModelList({ models }: { models: readonly UsageModelDisplayRow[] }) {
  return (
    <div className={cx(DS.surface.divided, "@container/usage-models")}>
      {models.map((row) => {
        const unattributed = row.model === COPILOT_USAGE_UNATTRIBUTED_MODEL;
        const unpriced = !unattributed && (row.pricingStatus === "unpriced"
          || (row.hasUnpricedUsage && !row.estimatedCostUsd));
        const estimate = row.hasCostEstimate === false || unpriced || unattributed ? null : row.estimatedCostUsd;
        const metered = hasMeteredUsage(row);
        const pricingLabel = unattributed ? "Not model-attributed" : unpriced ? "Unpriced"
          : row.hasUnpricedUsage ? "Partial estimate" : row.pricingStatus === "sdk-name" ? "Matched SDK name"
            : row.pricingStatus === "exact" ? "Price card matched" : null;
        const pricedAs = row.pricedAs ?? row.pricingKey;

        return (
          <details key={`${row.model}:${row.contextTier ?? "default"}`} className={DS.details.root}>
            <summary className={cx(DS.usage.rowSummary, DS.focus)}>
              <ChevronRight size={13} aria-hidden="true" className={DS.details.chevron} />
              <span className="min-w-0 flex-1 break-words font-medium text-text-primary">
                {row.model}
                {row.contextTierLabel && <span className="ml-2 text-xs font-normal text-text-secondary">{row.contextTierLabel}</span>}
              </span>
              <span className={DS.usage.figures}>
                <span>
                  {unattributed ? `${formatUsageCredits(row.meteredAiCredits)} metered AI credits`
                    : unpriced ? "Unpriced" : estimate == null ? "Estimate unavailable" : `${formatUsageUsd(estimate)} est.`}
                </span>
                {!unattributed && <span>{formatUsageNumber(row.totalTokens)} tokens</span>}
              </span>
            </summary>
            <div className={cx(DS.rail, "space-y-4 pb-3")}>
              <StatRow stats={[
                { label: "Sessions", value: formatUsageNumber(row.sessions) },
                { label: "Requests", value: formatUsageNumber(row.requests) },
                { label: "Est. cost", value: unattributed || unpriced ? "Not priced" : formatUsageUsd(estimate) },
                { label: "Est. credits", value: unattributed || unpriced ? "Not priced" : formatUsageCredits(row.estimatedAiCredits) },
                { label: "Metered cost", value: formatUsageUsd(meteredCostUsd(row)) },
                { label: "Metered credits", value: metered ? formatUsageCredits(row.meteredAiCredits) : "Not recorded" },
              ]} />
              <p className={DS.usage.prose}>
                {unattributed ? "metered total only; the SDK did not assign this cost to a model."
                  : metered ? `SDK-reported metering ${describeMeteredCoverage(row)}.` : "No GitHub metering recorded for this model."}
              </p>
              {pricingLabel && (
                <FieldList>
                  <Field label="Pricing">
                    <Badge tone={unpriced || row.hasUnpricedUsage ? "warning" : "neutral"}>{pricingLabel}</Badge>
                    {pricedAs && pricedAs !== row.model && <span className="ml-2 text-xs text-text-secondary">priced as {pricedAs}</span>}
                    {unpriced && <span className="ml-2 text-xs text-text-secondary">excluded from cost</span>}
                  </Field>
                  {row.normalizedPricingModel && row.normalizedPricingModel !== row.model && (
                    <Field label="Price lookup" mono>{row.normalizedPricingModel}</Field>
                  )}
                </FieldList>
              )}
              {!unattributed && <Section label="Token breakdown"><TokenBreakdown totals={row} /></Section>}
            </div>
          </details>
        );
      })}
    </div>
  );
}
