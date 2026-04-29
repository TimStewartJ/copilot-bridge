import { describe, expect, it } from "vitest";
import type { PendingTool } from "./useSessionStream";
import {
  buildTerminalToolEntries,
  bufferPendingToolPrelude,
  collectTerminalPendingTools,
  createVisualEntryFromPublishedEvent,
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

describe("createVisualEntryFromPublishedEvent", () => {
  it("preserves live Vega-Lite visual kind and source", () => {
    const entry = createVisualEntryFromPublishedEvent({
      artifactId: "artifact-1",
      kind: "vega-lite",
      title: "Chart",
      displayName: "chart.vl.json",
      mimeType: "application/vnd.vegalite+json",
      size: 128,
      url: "/api/sessions/s/visuals/artifact-1",
      downloadUrl: "/api/sessions/s/visuals/artifact-1/download",
      source: "{\"mark\":\"bar\"}",
      timestamp: "2026-04-28T00:00:00.000Z",
    });

    expect(entry).toMatchObject({
      id: "stream-visual-artifact-1",
      type: "visual",
      timestamp: "2026-04-28T00:00:00.000Z",
      visual: {
        artifactId: "artifact-1",
        kind: "vega-lite",
        title: "Chart",
        source: "{\"mark\":\"bar\"}",
      },
    });
  });

  it("preserves live HTML visual kind and source", () => {
    const entry = createVisualEntryFromPublishedEvent({
      artifactId: "artifact-2",
      kind: "html",
      title: "Mockup",
      url: "/api/sessions/s/visuals/artifact-2",
      source: "<h1>Hello</h1>",
    });

    expect(entry?.visual).toMatchObject({
      artifactId: "artifact-2",
      kind: "html",
      mimeType: "text/html",
      source: "<h1>Hello</h1>",
    });
  });

  it("returns null for malformed live visual events", () => {
    expect(createVisualEntryFromPublishedEvent({ artifactId: "artifact-3" })).toBeNull();
    expect(createVisualEntryFromPublishedEvent({ url: "/missing-id" })).toBeNull();
  });
});
