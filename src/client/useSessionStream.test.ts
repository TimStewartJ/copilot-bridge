import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const telemetryBatcherMock = vi.hoisted(() => ({
  enqueue: vi.fn(),
  flush: vi.fn(),
  flushSync: vi.fn(),
  getPendingCount: vi.fn(() => 0),
  dispose: vi.fn(),
}));

vi.mock("./telemetry-batcher", () => ({
  createTelemetryBatcher: () => telemetryBatcherMock,
}));

import {
  createReactDomHarness,
  waitTick,
  waitUntilAct,
  type Act,
} from "./test-react-harness";
import type { Attachment, PendingUserInputRequestView } from "./api";
import type { PendingTool } from "./useSessionStream";
import {
  buildSnapshotToolState,
  buildTerminalToolEntries,
  bufferPendingToolPrelude,
  collectTerminalPendingTools,
  createVisualEntryFromPublishedEvent,
  getKnownToolName,
  materializePendingTool,
  resolvePendingToolName,
  useSessionStream,
} from "./useSessionStream";

function createPendingTool(toolCallId: string, partial: Partial<PendingTool> = {}): PendingTool {
  return {
    toolCallId,
    name: partial.name ?? "bash",
    ...partial,
  };
}

type SessionStreamState = ReturnType<typeof useSessionStream>;

function createControlledSseResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });

  return {
    response: { ok: true, body } as unknown as Response,
    emit(event: unknown) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

async function withSessionStreamHarness(
  run: (helpers: {
    getState: () => SessionStreamState;
    act: Act;
  }) => Promise<void>,
): Promise<void> {
  const harness = await createReactDomHarness();
  let currentState: SessionStreamState | null = null;
  const getState = () => {
    if (!currentState) throw new Error("Stream harness has not rendered");
    return currentState;
  };

  function StreamHarness() {
    currentState = useSessionStream("session-1", vi.fn(), vi.fn());
    return null;
  }

  try {
    await harness.render(createElement(StreamHarness));
    await waitUntilAct(harness.act, () => currentState !== null);
    await run({ getState, act: harness.act });
  } finally {
    await harness.cleanup();
  }
}

async function emitAndWait(
  act: Act,
  sse: ReturnType<typeof createControlledSseResponse>,
  event: unknown,
  predicate: () => boolean,
) {
  await act(async () => {
    sse.emit(event);
  });
  await waitUntilAct(act, predicate);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

describe("useSessionStream send modes", () => {
  it("posts autopilot mode and tracks it while opening the live stream", async () => {
    await withSessionStreamHarness(async ({ getState, act }) => {
      const sse = createControlledSseResponse();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
        .mockResolvedValueOnce(sse.response);
      vi.stubGlobal("fetch", fetchMock);

      await act(async () => {
        await getState().sendMessage("keep going", undefined, "autopilot");
      });
      await waitUntilAct(act, () => fetchMock.mock.calls.length === 2);

      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chat");
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        sessionId: "session-1",
        prompt: "keep going",
        mode: "autopilot",
      });
      expect(getState().pendingOrigin).toBe("message");
      expect(getState().runMode).toBe("autopilot");
    });
  });
});

describe("buildTerminalToolEntries", () => {
  it("marks terminal tool rows done on successful turn completion", () => {
    const entries = buildTerminalToolEntries([
      createPendingTool("tool-1", { turnId: "turn-1", progressText: "Finishing up" }),
    ], "done", "2026-04-24T00:00:00.000Z");

    expect(entries).toMatchObject([
      {
        type: "tool",
        turnId: "turn-1",
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

describe("useSessionStream user input state", () => {
  it("hydrates pending requests from snapshots and removes answered or canceled requests", async () => {
    await withSessionStreamHarness(async ({ getState, act }) => {
      const sse = createControlledSseResponse();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse.response);

      await act(async () => {
        getState().reconnect("session-1");
      });
      await waitUntilAct(act, () => fetchMock.mock.calls.length === 1);

      const firstRequest: PendingUserInputRequestView = {
        requestId: "request-1",
        question: "Pick a lane",
        choices: ["fast", "safe"],
        allowFreeform: false,
        requestedAt: "2026-04-29T12:00:00.000Z",
      };
      await emitAndWait(act, sse, {
        type: "snapshot",
        accumulatedContent: "",
        activeTools: [],
        intentText: "",
        complete: false,
        pendingUserInputs: [firstRequest],
      }, () => getState().pendingUserInputs.length === 1);

      expect(getState().pendingUserInputs).toEqual([firstRequest]);

      await emitAndWait(act, sse, {
        type: "user_input_requested",
        requestId: "request-2",
        question: "Explain why",
        allowFreeform: true,
        timestamp: "2026-04-29T12:00:01.000Z",
      }, () => getState().pendingUserInputs.length === 2);

      expect(getState().pendingUserInputs).toMatchObject([
        firstRequest,
        {
          requestId: "request-2",
          question: "Explain why",
          allowFreeform: true,
          requestedAt: "2026-04-29T12:00:01.000Z",
        },
      ]);

      await emitAndWait(act, sse, {
        type: "user_input_answered",
        requestId: "request-1",
        answer: "fast",
        wasFreeform: false,
      }, () => getState().pendingUserInputs.length === 1);

      expect(getState().pendingUserInputs.map((request) => request.requestId)).toEqual(["request-2"]);

      await emitAndWait(act, sse, {
        type: "user_input_canceled",
        requestId: "request-2",
        reason: "session_ended",
      }, () => getState().pendingUserInputs.length === 0);

      expect(getState().pendingUserInputs).toEqual([]);
      await act(async () => {
        sse.close();
        await waitTick();
      });
    });
  });
});

describe("useSessionStream chat sends", () => {
  it("uses the chat wrapper and connects the stream for ordinary accepted sends", async () => {
    await withSessionStreamHarness(async ({ getState, act }) => {
      const sse = createControlledSseResponse();
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/chat") {
          return jsonResponse({ status: "accepted" });
        }
        if (url === "/api/sessions/session-1/stream") {
          return sse.response;
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      await act(async () => {
        await getState().sendMessage("hello");
      });

      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        sessionId: "session-1",
        prompt: "hello",
      });
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/chat",
        "/api/sessions/session-1/stream",
      ]);
      expect(getState().pendingOrigin).toBe("message");

      await act(async () => {
        sse.close();
        await waitTick();
      });
    });
  });

  it("does not reconnect or clear live stream state for steered sends", async () => {
    await withSessionStreamHarness(async ({ getState, act }) => {
      const sse = createControlledSseResponse();
      let streamSignal: AbortSignal | undefined;
      const attachments: Attachment[] = [
        {
          type: "file",
          path: "attachments/screenshot.png",
          displayName: "screenshot.png",
        },
      ];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/sessions/session-1/stream") {
          streamSignal = init?.signal ?? undefined;
          return sse.response;
        }
        if (url === "/api/chat") {
          return jsonResponse({ status: "accepted", mode: "steered" });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      await act(async () => {
        getState().reconnect("session-1");
      });
      await waitUntilAct(act, () => fetchMock.mock.calls.length === 1);

      const pendingRequest: PendingUserInputRequestView = {
        requestId: "request-1",
        question: "Pick a lane",
        allowFreeform: true,
      };
      await emitAndWait(act, sse, {
        type: "snapshot",
        accumulatedContent: "Working",
        activeTools: [
          {
            toolCallId: "tool-1",
            name: "bash",
            progressText: "Running",
          },
        ],
        intentText: "Investigating",
        complete: false,
        pendingUserInputs: [pendingRequest],
      }, () => getState().streamingContent === "Working");

      await act(async () => {
        await getState().sendMessage("please adjust", attachments);
      });

      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        sessionId: "session-1",
        prompt: "please adjust",
        attachments,
      });
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/sessions/session-1/stream",
        "/api/chat",
      ]);
      expect(streamSignal?.aborted).toBe(false);
      expect(getState()).toMatchObject({
        streamingContent: "Working",
        streamStatus: "streaming",
        isStreaming: true,
        intentText: "Investigating",
        pendingUserInputs: [pendingRequest],
        activeTools: [
          {
            toolCallId: "tool-1",
            name: "bash",
            progressText: "Running",
          },
        ],
      });

      await emitAndWait(act, sse, {
        type: "delta",
        content: " more",
      }, () => getState().streamingContent === "Working more");

      await act(async () => {
        sse.close();
        await waitTick();
      });
    });
  });
});

describe("snapshot tool helpers", () => {
  it("emits current-turn snapshot tools while activeTools drives active state", () => {
    const state = buildSnapshotToolState({
      turnId: "turn-1",
      activeTools: [
        {
          toolCallId: "tool-active",
          name: "bash",
          progressText: "Running tests",
        },
      ],
      currentTurnTools: [
        {
          toolCallId: "tool-done",
          name: "view",
          progressText: "Read file",
          result: "contents",
          success: true,
          completedAt: "2026-04-24T00:00:00.000Z",
          turnId: "turn-1",
        },
        {
          toolCallId: "tool-active",
          name: "bash",
          progressText: "Running tests",
        },
      ],
    }, "session-1");

    expect(state.activeTools).toMatchObject([
      {
        toolCallId: "tool-active",
        name: "bash",
        progressText: "Running tests",
      },
    ]);
    expect(state.currentTurnTools).toMatchObject([
      {
        toolCallId: "tool-done",
        name: "view",
        progressText: "Read file",
        result: "contents",
        success: true,
        completedAt: "2026-04-24T00:00:00.000Z",
      },
      {
        toolCallId: "tool-active",
        name: "bash",
        progressText: "Running tests",
      },
    ]);
    expect(state.toolEntries).toMatchObject([
      {
        type: "tool",
        liveSource: "snapshot",
        turnId: "turn-1",
        toolCall: {
          toolCallId: "tool-done",
          name: "view",
          progressText: "Read file",
          result: "contents",
          success: true,
          completedAt: "2026-04-24T00:00:00.000Z",
        },
      },
      {
        type: "tool",
        liveSource: "snapshot",
        turnId: "turn-1",
        toolCall: {
          toolCallId: "tool-active",
          name: "bash",
          progressText: "Running tests",
        },
      },
    ]);
  });

  it("deduplicates repeated reconnect snapshot tools by tool call id", () => {
    const state = buildSnapshotToolState({
      turnId: "turn-1",
      currentTurnTools: [
        {
          toolCallId: "tool-1",
          name: "unknown",
          progressText: "Starting",
        },
        {
          toolCallId: "tool-1",
          name: "bash",
          progressText: "Still running",
          result: "ok",
          success: true,
          completedAt: "2026-04-24T00:00:00.000Z",
        },
      ],
    }, "session-1");

    expect(state.currentTurnTools).toHaveLength(1);
    expect(state.toolEntries).toHaveLength(1);
    expect(state.currentTurnTools[0]).toMatchObject({
      toolCallId: "tool-1",
      name: "bash",
      progressText: "Still running",
      result: "ok",
      success: true,
      completedAt: "2026-04-24T00:00:00.000Z",
    });
  });

  it("falls back to activeTools for older snapshots without currentTurnTools", () => {
    const state = buildSnapshotToolState({
      turnId: "turn-1",
      activeTools: [
        {
          toolCallId: "tool-active",
          name: "bash",
          progressText: "Running",
        },
      ],
    }, "session-1");

    expect(state.activeTools).toHaveLength(1);
    expect(state.currentTurnTools).toMatchObject([
      {
        toolCallId: "tool-active",
        name: "bash",
        progressText: "Running",
      },
    ]);
    expect(state.toolEntries).toMatchObject([
      {
        type: "tool",
        liveSource: "snapshot",
        turnId: "turn-1",
        toolCall: {
          toolCallId: "tool-active",
          name: "bash",
          progressText: "Running",
        },
      },
    ]);
  });

  it("filters hidden tools from snapshot current-turn entries and active state", () => {
    const state = buildSnapshotToolState({
      activeTools: [
        { toolCallId: "visible-active", name: "bash" },
        { toolCallId: "intent-active", name: "report_intent" },
      ],
      currentTurnTools: [
        { toolCallId: "intent", name: "report_intent" },
        { toolCallId: "rename-local", name: "session_rename", args: { sessionId: "session-1" } },
        { toolCallId: "visible", name: "bash" },
      ],
    }, "session-1");

    expect(state.activeTools).toMatchObject([
      { toolCallId: "visible-active", name: "bash" },
    ]);
    expect(state.currentTurnTools).toMatchObject([
      { toolCallId: "visible", name: "bash" },
    ]);
    expect(state.toolEntries).toMatchObject([
      {
        type: "tool",
        liveSource: "snapshot",
        toolCall: {
          toolCallId: "visible",
          name: "bash",
        },
      },
    ]);
  });
});
