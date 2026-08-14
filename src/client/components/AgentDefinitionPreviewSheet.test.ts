import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, flushAct, type ReactDomHarness } from "../test-react-harness";

const fetchTaskAgentDefinition = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchTaskAgentDefinition,
  };
});

describe("AgentDefinitionPreviewSheet", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    fetchTaskAgentDefinition.mockReset();
  });

  it("renders formatted instructions and raw profile source", async () => {
    fetchTaskAgentDefinition.mockResolvedValue({
      taskId: "task-1",
      name: "api-reviewer",
      displayName: "API Reviewer",
      description: "Reviews API compatibility",
      tools: ["view"],
      infer: false,
      userInvocable: true,
      fileName: "api-reviewer.agent.md",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      prompt: "# Review rules\n\nCheck compatibility.",
      frontmatter: {},
      raw: "---\nname: API Reviewer\n---\n# Review rules",
    });
    harness = await createReactDomHarness();
    const { default: AgentDefinitionPreviewSheet } = await import("./AgentDefinitionPreviewSheet");
    await harness.render(createElement(AgentDefinitionPreviewSheet, {
      taskId: "task-1",
      definition: {
        taskId: "task-1",
        name: "api-reviewer",
        displayName: "API Reviewer",
        description: "Reviews API compatibility",
        tools: ["view"],
        infer: false,
        userInvocable: true,
        fileName: "api-reviewer.agent.md",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      },
      onClose: vi.fn(),
    }));
    await flushAct(harness.act, 2);

    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("Agent instructions");
    expect(text).toContain("Review rules");
    expect(text).toContain("Check compatibility.");
    expect(text).toContain("Raw profile");
    expect(text).toContain("name: API Reviewer");
  });
});
