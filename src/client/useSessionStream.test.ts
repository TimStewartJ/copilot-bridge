import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import type { ChatEntry } from "./api";
import type { SessionHistoryCoverage } from "../shared/session-stream.js";
import {
  buildSnapshotToolState,
  buildTerminalToolEntries,
  bufferPendingToolPrelude,
  createVisualEntryFromPublishedEvent,
  getKnownToolName,
  materializePendingTool,
  resolvePendingToolName,
  useSessionStream,
  type PendingTool,
} from "./useSessionStream";
import {
  createReactDomHarness,
  waitTick,
  waitUntilAct,
  type Act,
} from "./test-react-harness";

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  open() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  emit(event: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  fail() {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.(new Event("error"));
  }

  failClosed() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event("error"));
  }
}

type HookState = ReturnType<typeof useSessionStream>;

async function withHarness(
  run: (helpers: {
    getState: () => HookState;
    getSource: () => MockEventSource;
    settled: ReturnType<typeof vi.fn<() => void>>;
    titleChanged: ReturnType<typeof vi.fn<() => void>>;
    setCoverage: (coverage: SessionHistoryCoverage) => void;
    setSessionId: (sessionId: string | null) => void;
    act: Act;
  }) => Promise<void>,
) {
  const harness = await createReactDomHarness();
  let state: HookState | null = null;
  let updateCoverage: ((coverage: SessionHistoryCoverage) => void) | null = null;
  let updateSessionId: ((sessionId: string | null) => void) | null = null;
  const settled = vi.fn<() => void>();
  const titleChanged = vi.fn<() => void>();

  function TestComponent() {
    const [coverage, setCoverage] = useState<SessionHistoryCoverage>({});
    const [sessionId, setSessionId] = useState<string | null>("session-1");
    updateCoverage = setCoverage;
    updateSessionId = setSessionId;
    state = useSessionStream(sessionId, settled, titleChanged, coverage);
    return null;
  }

  try {
    await harness.render(createElement(TestComponent));
    await waitUntilAct(harness.act, () => state !== null);
    await run({
      getState: () => {
        if (!state) throw new Error("Hook is not rendered");
        return state;
      },
      getSource: () => {
        const source = MockEventSource.instances.at(-1);
        if (!source) throw new Error("No EventSource was created");
        return source;
      },
      settled,
      titleChanged,
      setCoverage: (coverage) => {
        if (!updateCoverage) throw new Error("Coverage setter is unavailable");
        updateCoverage(coverage);
      },
      setSessionId: (sessionId) => {
        if (!updateSessionId) throw new Error("Session setter is unavailable");
        updateSessionId(sessionId);
      },
      act: harness.act,
    });
  } finally {
    await harness.cleanup();
  }
}

async function emitAndWait(
  act: Act,
  source: MockEventSource,
  event: unknown,
  predicate: () => boolean,
) {
  await act(async () => {
    source.emit(event);
  });
  await waitUntilAct(act, predicate);
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  telemetryBatcherMock.enqueue.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSessionStream EventSource lifecycle", () => {
  it("sends a message and opens the session EventSource", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "accepted" }),
      } as Response);

      await act(async () => {
        await getState().sendMessage("hello", undefined, "autopilot");
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        sessionId: "session-1",
        prompt: "hello",
        mode: "autopilot",
      });
      expect(getSource().url).toBe("/api/sessions/session-1/stream");
      expect(getState()).toMatchObject({
        pendingOrigin: "message",
        runMode: "autopilot",
        streamStatus: "sending",
      });
    });
  });

  it("keeps live state while EventSource reconnects after a transport error", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await emitAndWait(act, source, {
        type: "snapshot",
        runId: "run-1",
        complete: false,
        turnId: "provider-turn-1",
        accumulatedContent: "working",
        assistantSegments: [],
        activeTools: [],
        currentTurnTools: [],
        visuals: [],
        entryOrder: [],
        pendingUserInputs: [],
        pendingElicitations: [],
      }, () => getState().streamingContent === "working");

      await act(async () => source.fail());

      expect(source.close).not.toHaveBeenCalled();
      expect(MockEventSource.instances).toHaveLength(1);
      expect(getState()).toMatchObject({
        isStreaming: true,
        streamingContent: "working",
      });
    });
  });

  it("settles instead of sticking when EventSource reports a fatal close", async () => {
    await withHarness(async ({ getState, getSource, settled, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await act(async () => source.failClosed());
      await waitUntilAct(act, () => getState().streamStatus === "idle");

      expect(source.close).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledOnce();
    });
  });

  it("closes on terminal events and retains the overlay until disk coverage arrives", async () => {
    await withHarness(async ({ getState, getSource, settled, titleChanged, setCoverage, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "thinking",
        turnId: "provider-turn-1",
      }, () => getState().streamStatus === "thinking");
      await emitAndWait(act, source, {
        type: "delta",
        turnId: "provider-turn-1",
        content: "Final answer",
      }, () => getState().streamingContent === "Final answer");
      await emitAndWait(act, source, {
        type: "done",
        turnId: "provider-turn-1",
        sourceEventId: "terminal-event-1",
        content: "Final answer",
        timestamp: "2026-07-21T17:00:00.000Z",
      }, () => getState().streamStatus === "idle");

      expect(source.close).toHaveBeenCalledOnce();
      expect(getState().terminalEventId).toBe("terminal-event-1");
      expect(getState().liveEntries).toMatchObject([
        {
          role: "assistant",
          content: "Final answer",
          turnId: "provider-turn-1",
          sourceEventId: "terminal-event-1",
        },
      ]);
      expect(settled).toHaveBeenCalledOnce();
      expect(titleChanged).toHaveBeenCalledOnce();

      await act(async () => setCoverage({ latestTerminalEventId: "terminal-event-1" }));
      await waitUntilAct(act, () => getState().liveEntries.length === 0);
      expect(getState().terminalEventId).toBeUndefined();
    });
  });

  it("reuses the persisted assistant message identity at the terminal boundary", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "delta",
        turnId: "provider-turn-1",
        content: "Final answer",
      }, () => getState().streamingContent === "Final answer");
      await emitAndWait(act, source, {
        type: "assistant_partial",
        turnId: "provider-turn-1",
        sourceEventId: "assistant-event-1",
        content: "Final answer",
        timestamp: "2026-07-21T17:00:00.000Z",
      }, () => getState().liveEntries.length === 1);
      await emitAndWait(act, source, {
        type: "done",
        turnId: "provider-turn-1",
        sourceEventId: "terminal-event-1",
        assistantSourceEventId: "assistant-event-1",
        content: "Final answer",
        timestamp: "2026-07-21T17:00:01.000Z",
      }, () => getState().streamStatus === "idle");

      expect(getState().liveEntries).toMatchObject([
        {
          id: "live-assistant-assistant-event-1",
          role: "assistant",
          content: "Final answer",
          sourceEventId: "assistant-event-1",
        },
      ]);
      expect(getState().terminalEventId).toBe("terminal-event-1");
    });
  });

  it("updates the matching assistant entry for interrupted terminal events", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "assistant_partial",
        turnId: "provider-turn-1",
        sourceEventId: "assistant-event-1",
        content: "Partial answer",
      }, () => getState().liveEntries.length === 1);
      await emitAndWait(act, source, {
        type: "shutdown",
        turnId: "provider-turn-1",
        sourceEventId: "terminal-event-1",
        assistantSourceEventId: "assistant-event-1",
        content: "Partial answer",
      }, () => getState().streamStatus === "idle");

      expect(getState().liveEntries).toMatchObject([
        {
          id: "live-assistant-assistant-event-1",
          content: "Partial answer\n\n*(interrupted)*",
          sourceEventId: "assistant-event-1",
        },
      ]);
    });
  });

  it("deduplicates complete reconnect snapshots by assistant message identity", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "snapshot",
        runId: "run-1",
        complete: true,
        turnId: "provider-turn-1",
        accumulatedContent: "",
        assistantSegments: [{
          id: "assistant-event-1",
          sourceEventId: "assistant-event-1",
          turnId: "provider-turn-1",
          content: "Final answer",
        }],
        activeTools: [],
        currentTurnTools: [],
        visuals: [],
        entryOrder: ["assistant:assistant-event-1"],
        pendingUserInputs: [],
        pendingElicitations: [],
        terminalType: "done",
        terminalEventId: "terminal-event-1",
        terminalAssistantEventId: "assistant-event-1",
        finalContent: "Final answer",
      }, () => getState().streamStatus === "idle");

      expect(getState().liveEntries).toMatchObject([
        {
          id: "live-assistant-assistant-event-1",
          content: "Final answer",
          sourceEventId: "assistant-event-1",
        },
      ]);
      expect(getState().terminalEventId).toBe("terminal-event-1");
    });
  });

  it("uses the persisted assistant identity when a terminal snapshot has no live segment", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "snapshot",
        runId: "run-1",
        complete: true,
        turnId: "provider-turn-1",
        accumulatedContent: "",
        assistantSegments: [],
        activeTools: [],
        currentTurnTools: [],
        visuals: [],
        entryOrder: [],
        pendingUserInputs: [],
        pendingElicitations: [],
        terminalType: "done",
        terminalAssistantEventId: "assistant-event-1",
        finalContent: "Final answer",
      }, () => getState().streamStatus === "idle");

      expect(getState().liveEntries).toMatchObject([
        {
          id: "live-assistant-assistant-event-1",
          content: "Final answer",
          sourceEventId: "assistant-event-1",
        },
      ]);
    });
  });

  it("replaces the whole live overlay from reconnect snapshots", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await emitAndWait(act, source, {
        type: "snapshot",
        runId: "run-1",
        turnId: "provider-turn-1",
        complete: false,
        accumulatedContent: "",
        assistantSegments: [
          {
            id: "assistant-event-1",
            sourceEventId: "assistant-event-1",
            turnId: "provider-turn-1",
            content: "Before tool",
          },
        ],
        activeTools: [],
        currentTurnTools: [
          {
            toolCallId: "tool-1",
            name: "bash",
            turnId: "provider-turn-1",
            success: true,
          },
        ],
        visuals: [],
        entryOrder: ["assistant:assistant-event-1", "tool:tool-1"],
        pendingUserInputs: [],
        pendingElicitations: [],
      }, () => getState().liveEntries.length === 2);

      expect(getState().liveEntries.map((entry) => entry.type ?? "message")).toEqual(["message", "tool"]);

      await emitAndWait(act, source, {
        type: "snapshot",
        runId: "run-1",
        turnId: "provider-turn-1",
        complete: false,
        accumulatedContent: "replacement",
        assistantSegments: [],
        activeTools: [],
        currentTurnTools: [],
        visuals: [],
        entryOrder: [],
        pendingUserInputs: [],
        pendingElicitations: [],
      }, () => getState().streamingContent === "replacement");

      expect(getState().liveEntries).toEqual([]);
    });
  });

  it("settles deterministically when no live projection exists", async () => {
    await withHarness(async ({ getState, getSource, settled, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await emitAndWait(act, source, { type: "resync_required" }, () => getState().streamStatus === "idle");

      expect(source.close).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledOnce();
      expect(getState().liveEntries).toEqual([]);
    });
  });

  it("does not replace the active EventSource for steered sends", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "accepted", mode: "steered" }),
      } as Response);

      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await emitAndWait(act, source, {
        type: "snapshot",
        complete: false,
        accumulatedContent: "working",
        assistantSegments: [],
        activeTools: [],
        currentTurnTools: [],
        visuals: [],
        entryOrder: [],
        pendingUserInputs: [],
        pendingElicitations: [],
      }, () => getState().streamingContent === "working");

      await act(async () => {
        await getState().sendMessage("adjust");
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(MockEventSource.instances).toHaveLength(1);
      expect(source.close).not.toHaveBeenCalled();
      expect(getState().streamingContent).toBe("working");
    });
  });

  it("does not open an old session stream when navigation wins the send race", async () => {
    await withHarness(async ({ getState, setSessionId, act }) => {
      let resolveSend!: (response: Response) => void;
      vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((resolve) => {
        resolveSend = resolve;
      }));

      let sendPromise!: Promise<void>;
      await act(async () => {
        sendPromise = getState().sendMessage("hello");
        await waitTick();
      });
      await act(async () => {
        setSessionId("session-2");
        await waitTick();
      });
      resolveSend({
        ok: true,
        json: async () => ({ status: "accepted" }),
      } as Response);
      await act(async () => {
        await sendPromise;
      });

      expect(MockEventSource.instances).toHaveLength(0);
      expect(getState().streamStatus).toBe("idle");
    });
  });
});

describe("useSessionStream projection events", () => {
  it("hydrates, appends, and commits server-owned user messages", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await emitAndWait(act, source, {
        type: "snapshot",
        complete: false,
        accumulatedContent: "",
        userMessages: [
          {
            id: "user-1",
            content: "yes",
            pending: false,
            sourceEventId: "user-event-1",
          },
          {
            id: "user-2",
            content: "yes",
            pending: true,
            attachments: [{
              type: "uploaded",
              displayName: "example.png",
              mimeType: "image/png",
              size: 10,
            }],
          },
        ],
        assistantSegments: [],
        activeTools: [],
        currentTurnTools: [],
        visuals: [],
        entryOrder: ["user:user-1", "user:user-2"],
        pendingUserInputs: [],
        pendingElicitations: [],
      }, () => getState().liveEntries.length === 2);

      expect(getState().liveEntries).toMatchObject([
        {
          id: "live-user-user-1",
          role: "user",
          content: "yes",
          sourceEventId: "user-event-1",
        },
        {
          id: "live-user-user-2",
          role: "user",
          content: "yes",
          attachments: [{ displayName: "example.png" }],
        },
      ]);

      await emitAndWait(act, source, {
        type: "user_message",
        userMessage: {
          id: "user-3",
          content: "next",
          pending: true,
        },
      }, () => getState().liveEntries.length === 3);
      await emitAndWait(act, source, {
        type: "user_message_committed",
        id: "user-3",
        sourceEventId: "user-event-3",
        timestamp: "2026-07-21T22:00:00.000Z",
      }, () => getState().liveEntries[2]?.sourceEventId === "user-event-3");

      expect(getState().liveEntries[2]).toMatchObject({
        id: "live-user-user-3",
        content: "next",
        sourceEventId: "user-event-3",
        timestamp: "2026-07-21T22:00:00.000Z",
      });
    });
  });

  it("hydrates and resolves pending interactions", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await emitAndWait(act, source, {
        type: "snapshot",
        complete: false,
        accumulatedContent: "",
        assistantSegments: [],
        activeTools: [],
        currentTurnTools: [],
        visuals: [],
        entryOrder: [],
        pendingUserInputs: [{
          requestId: "input-1",
          question: "Continue?",
          allowFreeform: true,
        }],
        pendingElicitations: [{
          requestId: "el-1",
          message: "Choose",
          mode: "url",
          url: "https://example.com",
        }],
      }, () => getState().pendingUserInputs.length === 1);

      expect(getState().pendingElicitations).toHaveLength(1);
      await emitAndWait(act, source, {
        type: "user_input_answered",
        requestId: "input-1",
      }, () => getState().pendingUserInputs.length === 0);
      await emitAndWait(act, source, {
        type: "elicitation_canceled",
        requestId: "el-1",
        reason: "session_ended",
      }, () => getState().pendingElicitations.length === 0);
      expect(getState().elicitationCancellation).toMatchObject({
        requestId: "el-1",
        question: "Choose",
      });
    });
  });

  it("keeps tool, assistant, and visual entries in event order", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await emitAndWait(act, source, {
        type: "thinking",
        turnId: "provider-turn-1",
      }, () => getState().streamStatus === "thinking");
      await emitAndWait(act, source, {
        type: "assistant_partial",
        turnId: "provider-turn-1",
        sourceEventId: "assistant-1",
        content: "Checking",
      }, () => getState().liveEntries.length === 1);
      await emitAndWait(act, source, {
        type: "tool_start",
        turnId: "provider-turn-1",
        sourceEventId: "tool-start-1",
        toolCallId: "tool-1",
        name: "bash",
      }, () => getState().currentTurnTools.length === 1);
      await emitAndWait(act, source, {
        type: "tool_done",
        turnId: "provider-turn-1",
        sourceEventId: "tool-done-1",
        toolCallId: "tool-1",
        name: "bash",
        success: true,
        result: "ok",
      }, () => getState().currentTurnTools[0]?.success === true);
      await emitAndWait(act, source, {
        type: "visual_published",
        artifactId: "visual-1",
        kind: "html",
        title: "Preview",
        displayName: "preview.html",
        mimeType: "text/html",
        size: 10,
        url: "/visual-1",
        downloadUrl: "/visual-1/download",
      }, () => getState().liveEntries.length === 3);

      expect(getState().liveEntries.map((entry) => entry.type ?? "message")).toEqual([
        "message",
        "tool",
        "visual",
      ]);
    });
  });
});

describe("stream projection helpers", () => {
  it("preserves pre-start tool progress", () => {
    const prelude = bufferPendingToolPrelude(undefined, {
      toolCallId: "tool-1",
      progressText: "Running",
    });
    expect(materializePendingTool({
      toolCallId: "tool-1",
      name: resolvePendingToolName("bash", prelude),
    }, prelude)).toMatchObject({
      name: "bash",
      progressText: "Running",
    });
    expect(getKnownToolName("unknown")).toBeUndefined();
  });

  it("builds snapshot tools without hidden tools", () => {
    const state = buildSnapshotToolState({
      turnId: "provider-turn-1",
      activeTools: [
        { toolCallId: "visible", name: "bash" },
        { toolCallId: "hidden", name: "report_intent" },
      ],
      currentTurnTools: [
        { toolCallId: "visible", name: "bash", success: true },
        { toolCallId: "hidden", name: "report_intent", success: true },
      ],
    }, "session-1");
    expect(state.activeTools.map((tool) => tool.toolCallId)).toEqual(["visible"]);
    expect(state.currentTurnTools).toMatchObject([{ toolCallId: "visible", success: true }]);
  });

  it("marks incomplete tools at terminal boundaries", () => {
    const tools: PendingTool[] = [{ toolCallId: "tool-1", name: "bash" }];
    expect(buildTerminalToolEntries(tools, "shutdown", "2026-07-21T17:00:00.000Z")).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-1",
          success: false,
          completedAt: "2026-07-21T17:00:00.000Z",
        },
      },
    ]);
  });

  it("normalizes live visual events", () => {
    expect(createVisualEntryFromPublishedEvent({
      artifactId: "visual-1",
      kind: "vega-lite",
      title: "Chart",
      displayName: "chart.json",
      url: "/visual-1",
      source: "{\"mark\":\"bar\"}",
    })).toMatchObject({
      id: "live-visual-visual-1",
      type: "visual",
      visual: {
        kind: "vega-lite",
        source: "{\"mark\":\"bar\"}",
      },
    });
  });
});
