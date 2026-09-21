import type { CopilotUsageTotals } from "../api";
import { COPILOT_AI_CREDIT_USD } from "../../shared/copilot-pricing";

const NUMBER = new Intl.NumberFormat();
const CREDITS = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const SMALL_CREDITS = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const USD = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SMALL_USD = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 });

export function formatUsageNumber(value: number): string {
  return Number.isFinite(value) && value >= 0 ? NUMBER.format(value) : "Unavailable";
}

/** Missing metering is not a free run, and a small positive cost must not read as zero. */
export function formatUsageUsd(value: number | null | undefined): string {
  if (value == null) return "Not recorded";
  if (!Number.isFinite(value) || value < 0) return "Unavailable";
  if (value === 0 || value >= 0.01) return USD.format(value);
  return value < 0.000001 ? "<$0.000001" : SMALL_USD.format(value);
}

export function formatUsageCredits(value: number | null | undefined): string {
  if (value == null) return "Not recorded";
  if (!Number.isFinite(value) || value < 0) return "Unavailable";
  if (value === 0) return "0";
  if (value < 0.0001) return "<0.0001";
  return value < 1 ? SMALL_CREDITS.format(value) : CREDITS.format(value);
}

export function hasMeteredUsage(totals: Pick<CopilotUsageTotals, "meteredAiCredits" | "meteredTokens">): boolean {
  // Unattributed session metering can have credits without a token count; a recorded free run
  // has metered tokens and zero credits. Both are readings, unlike an older unmetered log.
  return totals.meteredAiCredits > 0 || totals.meteredTokens > 0;
}

export function meteredCostUsd(totals: Pick<CopilotUsageTotals, "meteredAiCredits" | "meteredTokens">): number | null {
  return hasMeteredUsage(totals) ? totals.meteredAiCredits * COPILOT_AI_CREDIT_USD : null;
}

export function describeMeteredCoverage(totals: Pick<CopilotUsageTotals, "meteredTokens" | "totalTokens">): string {
  if (!Number.isFinite(totals.totalTokens) || !Number.isFinite(totals.meteredTokens)
    || totals.totalTokens < 0 || totals.meteredTokens < 0) return "Coverage unavailable";
  if (totals.totalTokens === 0) return "Token coverage not recorded";
  const fraction = totals.meteredTokens / totals.totalTokens;
  if (fraction >= 1) return "covers all tokens in range";
  // Rounding a partial reading up to 100% would silently erase its coverage warning.
  return `covers ${Math.min(99, Math.round(fraction * 100))}% of tokens in range`;
}
