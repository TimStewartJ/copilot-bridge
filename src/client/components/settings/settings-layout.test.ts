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
  it("has exactly 3 categories", () => {
    expect(SETTINGS_CATEGORIES).toHaveLength(3);
  });

  it("has expected category ids in order", () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.id)).toEqual(["general", "integrations", "diagnostics"]);
  });

  it("each category has a non-empty label", () => {
    for (const cat of SETTINGS_CATEGORIES) {
      expect(cat.label.length).toBeGreaterThan(0);
    }
  });

  it("covers all 14 sections across categories", () => {
    const allSections = SETTINGS_CATEGORIES.flatMap((c) => c.sections);
    expect(allSections).toHaveLength(14);
  });

  it("sections are non-overlapping across categories", () => {
    const allSections = SETTINGS_CATEGORIES.flatMap((c) => c.sections);
    const unique = new Set(allSections);
    expect(unique.size).toBe(allSections.length);
  });

  it("contains all expected section ids", () => {
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
      "updates",
      "browser-diagnostics",
      "voice-input",
      "bridge-status",
      "local-copilot-usage",
    ];
    const allSections = SETTINGS_CATEGORIES.flatMap((c) => c.sections);
    expect(new Set(allSections)).toEqual(new Set(expected));
  });

  it("shows updates first in general settings", () => {
    const general = getCategoryMeta("general");
    const diagnostics = getCategoryMeta("diagnostics");

    expect(general!.sections[0]).toBe("updates");
    expect(diagnostics!.sections).not.toContain("updates");
  });
});

describe("DEFAULT_CATEGORY", () => {
  it("is 'general'", () => {
    expect(DEFAULT_CATEGORY).toBe("general");
  });
});

describe("normalizeCategory", () => {
  it("returns valid category ids as-is", () => {
    expect(normalizeCategory("general")).toBe("general");
    expect(normalizeCategory("integrations")).toBe("integrations");
    expect(normalizeCategory("diagnostics")).toBe("diagnostics");
  });

  it("falls back to default for null", () => {
    expect(normalizeCategory(null)).toBe(DEFAULT_CATEGORY);
  });

  it("falls back to default for undefined", () => {
    expect(normalizeCategory(undefined)).toBe(DEFAULT_CATEGORY);
  });

  it("falls back to default for empty string", () => {
    expect(normalizeCategory("")).toBe(DEFAULT_CATEGORY);
  });

  it("falls back to default for unknown string", () => {
    expect(normalizeCategory("unknown-category")).toBe(DEFAULT_CATEGORY);
    expect(normalizeCategory("GENERAL")).toBe(DEFAULT_CATEGORY);
    expect(normalizeCategory("  general  ")).toBe(DEFAULT_CATEGORY);
  });
});

describe("getCategoryMeta", () => {
  it("returns correct meta for each valid category", () => {
    const general = getCategoryMeta("general");
    expect(general).toBeDefined();
    expect(general!.id).toBe("general");
    expect(general!.label).toBe("General");
    expect(general!.sections).toContain("system-prompt");

    const integrations = getCategoryMeta("integrations");
    expect(integrations).toBeDefined();
    expect(integrations!.id).toBe("integrations");
    expect(integrations!.sections).toContain("mcp-servers");

    const diagnostics = getCategoryMeta("diagnostics");
    expect(diagnostics).toBeDefined();
    expect(diagnostics!.id).toBe("diagnostics");
    expect(diagnostics!.sections).toContain("local-copilot-usage");
  });

  it("returns undefined for an invalid cast", () => {
    expect(getCategoryMeta("nonexistent" as CategoryId)).toBeUndefined();
  });
});
