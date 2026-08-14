import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../../test-react-harness";
import AgentDefinitionsSection from "./AgentDefinitionsSection";

describe("AgentDefinitionsSection", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("expands attached agents and opens each preview", async () => {
    harness = await createReactDomHarness();
    const onPreview = vi.fn();
    const definition = {
      taskId: "task-1",
      name: "api-reviewer",
      displayName: "API Reviewer",
      description: "Reviews API compatibility",
      tools: null,
      infer: false,
      userInvocable: true,
      fileName: "api-reviewer.agent.md",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    await harness.render(createElement(AgentDefinitionsSection, {
      taskId: "task-1",
      definitions: [definition],
      onPreview,
    }));

    const buttons = findAllByTag(harness.dom.container, "BUTTON");
    await harness.act(async () => {
      getReactProps(buttons[0])?.onClick?.();
    });
    const previewButton = findAllByTag(harness.dom.container, "BUTTON")
      .find((button) => button.textContent?.includes("api-reviewer"));
    expect(previewButton).toBeTruthy();

    await harness.act(async () => {
      getReactProps(previewButton)?.onClick?.();
    });
    expect(onPreview).toHaveBeenCalledWith(definition);
  });
});
