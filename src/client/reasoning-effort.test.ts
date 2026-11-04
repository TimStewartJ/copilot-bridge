import { describe, expect, it } from "vitest";
import { formatReasoningEffortLabel } from "./reasoning-effort";

describe("formatReasoningEffortLabel", () => {
  it("formats efforts as title-cased words and returns undefined for empty input", () => {
    expect(formatReasoningEffortLabel()).toBeUndefined();
    expect(formatReasoningEffortLabel("")).toBeUndefined();
    const cases: [string, string][] = [
      ["low", "Low"],
      ["xhigh", "Xhigh"],
      ["max", "Max"],
      ["none", "None"],
      ["extra_high", "Extra High"],
      ["extra-high", "Extra High"],
    ];
    for (const [input, expected] of cases) {
      expect(formatReasoningEffortLabel(input), input).toBe(expected);
    }
    // A model that names its levels (Copilot Fusion's tiers) is shown by those names.
    const fusion = { reasoningEffortLabels: { "hydrafusion-max": "Max" } };
    expect(formatReasoningEffortLabel("hydrafusion-max", fusion)).toBe("Max");
    expect(formatReasoningEffortLabel("xhigh", fusion)).toBe("Xhigh");
  });
});
