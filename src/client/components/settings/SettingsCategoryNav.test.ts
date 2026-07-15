import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../../test-react-harness";
import { SettingsCategoryNav } from "./SettingsCategoryNav";

describe("SettingsCategoryNav", () => {
  it("shows category names without per-category section counts", async () => {
    const onSelectCategory = vi.fn();
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(SettingsCategoryNav, {
        activeCategory: "general",
        onSelectCategory,
      }));

      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("General");
      expect(text).toContain("Management");
      expect(text).not.toMatch(/\d+\s+sections?/);

      const managementButton = findAllByTag(harness.dom.container, "BUTTON")
        .find((button) => button.textContent?.trim() === "Management");
      if (!managementButton) throw new Error("Management category button not found");
      await harness.act(async () => {
        getReactProps(managementButton)?.onClick?.({});
      });
      expect(onSelectCategory).toHaveBeenCalledWith("management");
    } finally {
      await harness.cleanup();
    }
  });
});
