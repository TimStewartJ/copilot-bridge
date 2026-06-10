import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import SkillLoadedCard from "./SkillLoadedCard";
import type { ChatSkillEntry } from "../api";

const entry: ChatSkillEntry = {
  id: "skill-1",
  type: "skill",
  skill: { id: "skill-browser", label: "browser" },
  content: "<skill-context name=\"browser\">SECRET_BODY</skill-context>",
};

describe("SkillLoadedCard", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("renders a collapsed labeled entry and hides the injected content by default", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(SkillLoadedCard, { entry }));

    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("Skill loaded:");
    expect(text).toContain("browser");
    expect(text).not.toContain("SECRET_BODY");
  });

  it("reveals the injected content when expanded", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(SkillLoadedCard, { entry }));

    const button = findAllByTag(harness.dom.container, "BUTTON")[0];
    await harness.act(async () => {
      getReactProps(button)?.onClick?.();
    });

    expect(harness.dom.container.textContent ?? "").toContain("SECRET_BODY");
  });
});
