import { createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../api";
import { AUTOMATIC_ANSWERS } from "../../shared/automatic-answer.js";
import {
  COMPONENT_IMPORT_WARMUP_TIMEOUT_MS,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../test-react-harness";

let ToolCallBlock: typeof import("./ToolCallBlock").default;

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    ({ default: ToolCallBlock } = await import("./ToolCallBlock"));
  } finally {
    await harness.cleanup();
  }
}, COMPONENT_IMPORT_WARMUP_TIMEOUT_MS);

/** Render one tool row, open it, and return the text a reader then sees. */
async function openRow(toolCall: ToolCall): Promise<string> {
  const harness = await createReactDomHarness();
  try {
    await harness.render(createElement(ToolCallBlock, { toolCall }));
    const row = findAllByTag(harness.dom.container, "BUTTON")[0];
    if (!row) throw new Error("Tool row not found");
    await harness.act(async () => {
      getReactProps(row)?.onClick?.({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    return harness.dom.container.textContent ?? "";
  } finally {
    await harness.cleanup();
  }
}

describe("ToolCallBlock details", () => {
  it("shows command and progress in an open shell row until its final result replaces progress", async () => {
    const harness = await createReactDomHarness();
    const toolCall: ToolCall = {
      toolCallId: "shell-1", name: "powershell",
      args: { command: "git --no-pager log -3 --oneline" },
      progressText: "PARTIAL-OUTPUT", startedAt: "2026-09-20T08:00:00.000Z",
    };
    try {
      await harness.render(createElement(ToolCallBlock, { toolCall }));
      const [row] = findAllByTag(harness.dom.container, "BUTTON");
      await harness.act(async () => getReactProps(row)!.onClick());
      expect(harness.dom.container.textContent).toContain("Latest progress");
      expect(harness.dom.container.textContent).toContain("PARTIAL-OUTPUT");
      expect(harness.dom.container.textContent).not.toContain("Arguments");

      await harness.render(createElement(ToolCallBlock, { toolCall: {
        ...toolCall, args: { command: "git --no-pager log -3 --oneline", description: "Show the last commits", initial_wait: 30 },
        completedAt: "2026-09-20T08:00:02.000Z", success: true, result: "a052f73 Rebuild the Docs view",
      } }));
      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("Command");
      expect(text).toContain("git --no-pager log -3 --oneline");
      // The description is already the row's label, and the command has its own section.
      expect(text).toContain("Arguments");
      expect(text).toContain('"initial_wait": 30');
      expect(text).not.toContain('"command"');
      expect(text).not.toContain('"description"');
      expect(text).toContain("a052f73 Rebuild the Docs view");
      // The raw tool name stays one click away.
      expect(text).toContain("powershell");
      expect(text).not.toContain("Latest progress");
      expect(text).not.toContain("PARTIAL-OUTPUT");
    } finally { await harness.cleanup(); }
  });

  it("shows a question with the answer the CLI recorded, not its schema", async () => {
    const text = await openRow({
      toolCallId: "ask-1",
      name: "ask_user",
      args: {
        message: "Which **shape** should I create?",
        requestedSchema: {
          properties: {
            tracking: {
              type: "string",
              title: "Tracking",
              oneOf: [{ const: "feature_task", title: "Feature plus Task" }, { const: "none", title: "Nothing yet" }],
            },
          },
        },
      },
      startedAt: "2026-09-20T08:00:00.000Z",
      completedAt: "2026-09-20T08:05:00.000Z",
      success: true,
      result: "User responded:\nTracking: Feature plus Task",
    });

    expect(text).toContain("Tracking: Feature plus Task");
    expect(text).not.toContain("Nothing yet");
    expect(text).not.toContain("requestedSchema");
    expect(text).not.toContain("User responded");
  });

  it("says who went on without an answer instead of showing the automatic reply as one", async () => {
    const question = {
      toolCallId: "ask-2",
      name: "ask_user",
      args: {
        message: "Send the update?",
        requestedSchema: { properties: { send: { type: "string", oneOf: [{ const: "yes", title: "Send it" }] } } },
      },
      startedAt: "2026-09-20T08:00:00.000Z",
      success: true,
    };
    const inAutopilot = await openRow({
      ...question,
      completedAt: "2026-09-20T08:00:00.100Z",
      result: `User responded:\nsend: ${AUTOMATIC_ANSWERS.autopilot}`,
    });
    expect(inAutopilot).toContain("Autopilot went on without you");
    expect(inAutopilot).toContain("Send it");
    expect(inAutopilot).not.toContain("not shown to the user");

    const unanswered = await openRow({
      ...question,
      completedAt: "2026-09-20T08:30:00.000Z",
      result: `User responded:\nsend: ${AUTOMATIC_ANSWERS.unanswered}`,
    });
    expect(unanswered).toContain("Not answered, the run went on without you");
    expect(unanswered).not.toContain("not available to respond");
  });
});
