import { describe, expect, it } from "vitest";
import { describeMeteredCoverage, formatUsageCredits, formatUsageNumber, formatUsageUsd, hasMeteredUsage, meteredCostUsd } from "./usage-presentation";

describe("usage presentation", () => {
  it("separates a recorded zero from missing and invalid cost", () => {
    expect(formatUsageUsd(0)).toBe("$0.00");
    expect(formatUsageUsd(null)).toBe("Not recorded");
    expect(formatUsageUsd(undefined)).toBe("Not recorded");
    expect(formatUsageUsd(Number.NaN)).toBe("Unavailable");
    expect(formatUsageUsd(-1)).toBe("Unavailable");
  });

  it("retains small positive costs and credits instead of rounding them to zero", () => {
    expect(formatUsageUsd(0.0025)).toBe("$0.0025");
    expect(formatUsageUsd(0.0000001)).toBe("<$0.000001");
    expect(formatUsageUsd(32.75)).toBe("$32.75");
    expect(formatUsageCredits(0.0025)).toBe("0.0025");
    expect(formatUsageCredits(0.00001)).toBe("<0.0001");
    expect(formatUsageCredits(3275)).toBe("3,275");
    expect(formatUsageCredits(0)).toBe("0");
    expect(formatUsageCredits(null)).toBe("Not recorded");
    expect(formatUsageCredits(-1)).toBe("Unavailable");
    expect(formatUsageNumber(1234)).toBe("1,234");
  });

  it("recognizes both free recorded usage and credits with no model-attributed tokens", () => {
    expect(hasMeteredUsage({ meteredTokens: 100, meteredAiCredits: 0 })).toBe(true);
    expect(meteredCostUsd({ meteredTokens: 100, meteredAiCredits: 0 })).toBe(0);
    expect(meteredCostUsd({ meteredTokens: 0, meteredAiCredits: 123.45 })).toBeCloseTo(1.2345);
    expect(hasMeteredUsage({ meteredTokens: 0, meteredAiCredits: 0 })).toBe(false);
    expect(meteredCostUsd({ meteredTokens: 0, meteredAiCredits: 0 })).toBeNull();
  });

  it("labels partial metering and does not round a partial range up to complete", () => {
    expect(describeMeteredCoverage({ meteredTokens: 250, totalTokens: 1000 })).toBe("covers 25% of tokens in range");
    expect(describeMeteredCoverage({ meteredTokens: 998, totalTokens: 1000 })).toBe("covers 99% of tokens in range");
    expect(describeMeteredCoverage({ meteredTokens: 999, totalTokens: 1000 })).toBe("covers 99% of tokens in range");
    expect(describeMeteredCoverage({ meteredTokens: 1000, totalTokens: 1000 })).toBe("covers all tokens in range");
    expect(describeMeteredCoverage({ meteredTokens: 0, totalTokens: 0 })).toBe("Token coverage not recorded");
  });
});
