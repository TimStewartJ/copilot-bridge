import { describe, expect, it } from "vitest";
import type { PendingTool } from "./useSessionStream";
import {
  buildTerminalToolEntries,
  bufferPendingToolPrelude,
  collectTerminalPendingTools,
  getKnownToolName,
  materializePendingTool,
  resolvePendingToolName,
} from "./useSessionStream";

function createPendingTool(toolCallId: string, partial: Partial<PendingTool> = {}): PendingTool {
  return {
    toolCallId,
    name: partial.name ?? "bash",
    ...partial,
  };
}

describe("buildTerminalToolEntries", () => {
  it("marks terminal tool rows done on successful turn completion", () => {
    const entries = buildTerminalToolEntries([
      createPendingTool("tool-1", { progressText: "Finishing up" }),
    ], "done", "2026-04-24T00:00:00.000Z");

    expect(entries).toMatchObject([
      {
        type: "tool",
        liveSource: "event",
        toolCall: {
          toolCallId: "tool-1",
          progressText: "Finishing up",
          success: true,
          completedAt: "2026-04-24T00:00:00.000Z",
        },
      },
    ]);
  });

  it("marks terminal tool rows failed on interrupted turns", () => {
    const entries = buildTerminalToolEntries([
      createPendingTool("tool-2", { progressText: "Still running" }),
    ], "shutdown", "2026-04-24T00:00:01.000Z");

    expect(entries).toMatchObject([
      {
        type: "tool",
        liveSource: "event",
        toolCall: {
          toolCallId: "tool-2",
          progressText: "Still running",
          success: false,
          completedAt: "2026-04-24T00:00:01.000Z",
        },
      },
    ]);
  });
});

describe("buffered pending tool helpers", () => {
  it("applies pre-start progress once tool_start metadata arrives later", () => {
    const prelude = bufferPendingToolPrelude(undefined, {
      toolCallId: "tool-1",
      name: getKnownToolName("unknown"),
      progressText: "Running tests...",
    });

    const started = materializePendingTool({
      toolCallId: "tool-1",
      name: resolvePendingToolName("bash", prelude),
    }, prelude);

    expect(started).toMatchObject({
      toolCallId: "tool-1",
      name: "bash",
      progressText: "Running tests...",
    });
  });

  it("keeps a meaningful pre-start name when earlier updates already identified the tool", () => {
    const prelude = bufferPendingToolPrelude(undefined, {
      toolCallId: "tool-2",
      name: getKnownToolName("🤖 Explore agent"),
      progressText: "Searching files...",
      isSubAgent: true,
    });

    const started = materializePendingTool({
      toolCallId: "tool-2",
      name: resolvePendingToolName(undefined, prelude),
      isSubAgent: undefined,
    }, prelude);

    expect(started).toMatchObject({
      toolCallId: "tool-2",
      name: "🤖 Explore agent",
      progressText: "Searching files...",
      isSubAgent: true,
    });
  });

  it("keeps buffered pre-start tools when terminalizing alongside started tools", () => {
    const tools = collectTerminalPendingTools(
      [createPendingTool("tool-2", { name: "bash", progressText: "Running" })],
      [createPendingTool("tool-2", { name: "bash", progressText: "Running" })],
      [bufferPendingToolPrelude(undefined, {
        toolCallId: "tool-1",
        progressText: "Waiting for start",
      })],
    );

    expect(tools).toMatchObject([
      {
        toolCallId: "tool-2",
        name: "bash",
        progressText: "Running",
      },
      {
        toolCallId: "tool-1",
        name: "unknown",
        progressText: "Waiting for start",
      },
    ]);
  });
});
