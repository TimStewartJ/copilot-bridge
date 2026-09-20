import { createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../api";
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
  it("shows a shell command as itself, and only the remaining arguments as JSON", async () => {
    const text = await openRow({
      toolCallId: "shell-1",
      name: "powershell",
      args: { command: "git --no-pager log -3 --oneline", description: "Show the last commits", initial_wait: 30 },
      startedAt: "2026-09-20T08:00:00.000Z",
      completedAt: "2026-09-20T08:00:02.000Z",
      success: true,
      result: "a052f73 Rebuild the Docs view",
    });

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
  });

  it("drops the progress echo once a call has its result", async () => {
    const finished = await openRow({
      toolCallId: "shell-2",
      name: "powershell",
      args: { command: "npm test" },
      progressText: "PARTIAL-OUTPUT",
      startedAt: "2026-09-20T08:00:00.000Z",
      completedAt: "2026-09-20T08:00:05.000Z",
      success: true,
      result: "FINAL-OUTPUT",
    });

    expect(finished).toContain("FINAL-OUTPUT");
    expect(finished).not.toContain("Latest progress");
    expect(finished).not.toContain("PARTIAL-OUTPUT");
  });

  it("keeps showing progress while a call has nothing else to show for itself", async () => {
    const running = await openRow({
      toolCallId: "shell-3",
      name: "powershell",
      args: { command: "npm test" },
      progressText: "PARTIAL-OUTPUT",
      startedAt: "2026-09-20T08:00:00.000Z",
    });

    expect(running).toContain("Latest progress");
    expect(running).toContain("PARTIAL-OUTPUT");
  });
});
