import { describe, it, expect } from "vitest";
import {
  SETTINGS_CATEGORIES,
  DEFAULT_CATEGORY,
  normalizeCategory,
  getCategoryMeta,
  type CategoryId,
  type SectionId,
} from "./settings-layout.js";

describe("SETTINGS_CATEGORIES", () => {
  it("declares every category and section exactly once, in order", () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.id)).toEqual([
      "general",
      "integrations",
      "updates",
      "diagnostics",
      "usage",
    ]);

    const expected: SectionId[] = [
      "system-prompt",
      "model",
      "reasoning-effort",
      "appearance",
      "notifications",
      "device-management",
      "providers",
      "tags",
      "mcp-servers",
      "skills",
      "updates",
      "management-jobs",
      "browser-diagnostics",
      "voice-input",
      "bridge-status",
      "local-copilot-usage",
    ];
    const allSections = SETTINGS_CATEGORIES.flatMap((c) => c.sections);
    expect(new Set(allSections)).toEqual(new Set(expected));
    expect(new Set(allSections).size).toBe(allSections.length);
  });

  it("places sections in the categories that own them", () => {
    const general = getCategoryMeta("general");
    const integrations = getCategoryMeta("integrations");
    const updates = getCategoryMeta("updates");
    const diagnostics = getCategoryMeta("diagnostics");
    const usage = getCategoryMeta("usage");

    expect(general!.label).toBe("General");
    expect(general!.sections[0]).toBe("system-prompt");
    expect(general!.sections).not.toContain("updates");
    expect(integrations!.sections).toContain("mcp-servers");

    // The three update/deploy status surfaces live together, in read order:
    // what the release is, the job that performed it, whether it is live.
    expect(updates!.label).toBe("Updates & Deployment");
    expect(updates!.sections).toEqual(["updates", "management-jobs", "bridge-status"]);

    expect(diagnostics!.sections[0]).toBe("browser-diagnostics");
    expect(diagnostics!.sections).toContain("voice-input");
    expect(diagnostics!.sections).not.toContain("bridge-status");
    expect(diagnostics!.sections).not.toContain("updates");
    expect(diagnostics!.sections).not.toContain("management-jobs");
    expect(diagnostics!.sections).not.toContain("local-copilot-usage");
    expect(usage!.label).toBe("Copilot Usage");
    expect(usage!.sections).toEqual(["local-copilot-usage"]);
  });
});

describe("normalizeCategory", () => {
  it("passes through known ids and falls back to the default otherwise", () => {
    expect(DEFAULT_CATEGORY).toBe("general");
    for (const id of ["general", "integrations", "updates", "usage", "diagnostics"]) {
      expect(normalizeCategory(id)).toBe(id);
    }
    for (const bad of [null, undefined, "", "unknown-category", "GENERAL", "  general  "]) {
      expect(normalizeCategory(bad), String(bad)).toBe(DEFAULT_CATEGORY);
    }
  });

  it("maps the retired 'management' id forward so old ?group= links still resolve", () => {
    expect(normalizeCategory("management")).toBe("updates");
    expect(normalizeCategory("management")).not.toBe(DEFAULT_CATEGORY);
  });
});

describe("getCategoryMeta", () => {
  it("returns undefined for an invalid cast", () => {
    expect(getCategoryMeta("nonexistent" as CategoryId)).toBeUndefined();
  });
});
