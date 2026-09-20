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

import {
  getKnownToolName,
  normalizeLiveTools,
  normalizeRunNotice,
  retireSegmentsAtTurnBoundary,
  upsertLiveTool,
  useSessionStream,
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
    mcpStatusChanged: ReturnType<typeof vi.fn<(servers: unknown[]) => void>>;
    setSessionId: (sessionId: string | null) => void;
    act: Act;
  }) => Promise<void>,
) {
  const harness = await createReactDomHarness();
  let state: HookState | null = null;
  let updateSessionId: ((sessionId: string | null) => void) | null = null;
  const settled = vi.fn<() => void>();
  const titleChanged = vi.fn<() => void>();
  const mcpStatusChanged = vi.fn<(servers: unknown[]) => void>();

  function TestComponent() {
    const [sessionId, setSessionId] = useState<string | null>("session-1");
    updateSessionId = setSessionId;
    state = useSessionStream(sessionId, settled, titleChanged, mcpStatusChanged);
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
      mcpStatusChanged,
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


/** Build an ephemeral stream snapshot with sensible defaults for the fields under test. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    runId: "run-1",
    complete: false,
    streamingContent: "",
    liveAssistantSegments: [],
    pendingUserMessages: [],
    liveTools: [],
    liveVisuals: [],
    intentText: "",
    contextSummary: null,
    pendingUserInputs: [],
    pendingElicitations: [],
    ...overrides,
  };
}

describe("useSessionStream EventSource lifecycle", () => {
  it("keeps a healthy stream when asked to ensure a connection, and replaces a closed one", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().ensureConnected("session-1"));
      const first = getSource();
      first.open();
      await emitAndWait(act, first, snapshot({ streamingContent: "partial" }),
        () => getState().streamingContent === "partial");

      // A routine history refresh asks again; tearing the stream down would blank the overlay.
      await act(async () => getState().ensureConnected("session-1"));
      expect(MockEventSource.instances).toHaveLength(1);
      expect(first.close).not.toHaveBeenCalled();
      expect(getState().streamingContent).toBe("partial");

      await act(async () => first.failClosed());
      await act(async () => getState().ensureConnected("session-1"));
      expect(MockEventSource.instances).toHaveLength(2);

      // An explicit reconnect always replaces the stream: the caller suspects it died unnoticed.
      await act(async () => getState().reconnect("session-1"));
      expect(MockEventSource.instances).toHaveLength(3);
    });
  });

  it("publishes normalized MCP snapshots without mirroring them in stream state", async () => {
    await withHarness(async ({ getState, getSource, mcpStatusChanged, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await act(async () => source.emit(snapshot({
        mcpServers: [
          { name: "demo", status: "connected", source: "sdk" },
          { name: "future", status: "new-sdk-value" },
        ],
      })));
      expect(mcpStatusChanged).toHaveBeenLastCalledWith([
        { name: "demo", status: "connected", source: "sdk" },
        { name: "future", status: "unknown" },
      ]);
      expect(getState()).not.toHaveProperty("mcpServers");

      await act(async () => source.emit({
        type: "mcp_status",
        servers: [{ name: "demo", status: "failed", error: "offline" }],
      }));
      expect(mcpStatusChanged).toHaveBeenLastCalledWith([
        { name: "demo", status: "failed", error: "offline" },
      ]);
    });
  });

  it("sends a message and opens the session EventSource", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "accepted" }),
      } as Response);

      await act(async () => {
        await getState().sendMessage("hello", undefined, "autopilot", "client-message-1");
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        sessionId: "session-1",
        prompt: "hello",
        mode: "autopilot",
        clientMessageId: "client-message-1",
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
      await emitAndWait(act, source, snapshot({
        turnId: "provider-turn-1",
        turnInstanceId: "turn-start-event-1",
        streamingContent: "working",
      }), () => getState().streamingContent === "working");

      await act(async () => source.fail());

      expect(source.close).not.toHaveBeenCalled();
      expect(MockEventSource.instances).toHaveLength(1);
      expect(getState()).toMatchObject({
        isStreaming: true,
        streamingContent: "working",
        activeTurnId: "provider-turn-1",
        activeTurnInstanceId: "turn-start-event-1",
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

  it("does not replace the active EventSource for steered sends", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const original = getSource();
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "steered", mode: "steered" }),
      } as Response);

      await act(async () => {
        await getState().sendMessage("steer me");
      });

      expect(MockEventSource.instances).toHaveLength(1);
      expect(getSource()).toBe(original);
    });
  });

  it("does not open an old session stream when navigation wins the send race", async () => {
    await withHarness(async ({ getState, setSessionId, act }) => {
      let resolveSend!: (response: Response) => void;
      vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((resolve) => {
        resolveSend = resolve;
      }));

      let sendPromise!: Promise<unknown>;
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

describe("useSessionStream ephemeral state", () => {
  it("carries only ephemeral run state and never a committed transcript projection", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, snapshot({
        turnId: "provider-turn-1",
        streamingContent: "typing",
        liveAssistantSegments: [
          { id: "assistant-1", content: "hello", sourceEventId: "assistant-1" },
        ],
        pendingUserMessages: [{ id: "pending-1", content: "run it" }],
        liveTools: [{ toolCallId: "tc-1", name: "bash" }],
      }), () => getState().streamingContent === "typing");

      const state = getState();
      expect(state.liveAssistantSegments).toMatchObject([{ sourceEventId: "assistant-1" }]);
      expect(state.pendingUserMessages).toMatchObject([{ id: "pending-1", content: "run it" }]);
      expect(state.liveTools).toMatchObject([{ toolCallId: "tc-1", name: "bash" }]);
      expect(state.historyEpoch).toBeGreaterThan(0);
      // Committed transcript content is owned by events.jsonl, not the stream.
      expect(state).not.toHaveProperty("liveEntries");
      expect(state).not.toHaveProperty("currentTurnTools");
    });
  });

  it("advances the history epoch so the view can refresh disk history", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      const before = getState().historyEpoch;

      await emitAndWait(
        act,
        source,
        { type: "history_advanced" },
        () => getState().historyEpoch > before,
      );

      expect(getState().historyEpoch).toBe(before + 1);
    });
  });

  it("keeps advancing the epoch across runs even though the signal carries no sequence", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, snapshot({ runId: "run-1" }),
        () => getState().streamStatus !== "sending");
      const afterFirstRun = getState().historyEpoch;

      // A snapshot from a different run means committed history moved while disconnected.
      await emitAndWait(act, source, snapshot({ runId: "run-2" }),
        () => getState().historyEpoch > afterFirstRun);
      const afterSecondRun = getState().historyEpoch;

      await emitAndWait(act, source, { type: "history_advanced" },
        () => getState().historyEpoch > afterSecondRun);

      expect(getState().historyEpoch).toBe(afterSecondRun + 1);
    });
  });

  it("resets to idle and bumps the epoch when the server requires a resync", async () => {
    await withHarness(async ({ getState, getSource, settled, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, snapshot({ streamingContent: "typing" }),
        () => getState().streamingContent === "typing");
      const before = getState().historyEpoch;

      await emitAndWait(act, source, { type: "resync_required" },
        () => getState().streamStatus === "idle");

      const state = getState();
      expect(state.streamingContent).toBe("");
      expect(state.isStreaming).toBe(false);
      expect(state.historyEpoch).toBe(before + 1);
      expect(settled).toHaveBeenCalled();
    });
  });

  it("updates the context summary from a context_update event", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(
        act,
        source,
        { type: "context_update", summary: { sessionId: "session-1", tokensUsed: 4200, usageRatio: 0.42 } },
        () => getState().contextSummary !== null,
      );

      expect(getState().contextSummary).toMatchObject({ sessionId: "session-1", tokensUsed: 4200 });
    });
  });

  it("keeps a finished tool with its result so it can render before the next disk read", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "tool_start",
        toolCallId: "tc-1",
        name: "bash",
        timestamp: "2026-07-24T10:00:00.000Z",
      }, () => getState().liveTools.length === 1);

      await emitAndWait(act, source, {
        type: "tool_progress",
        toolCallId: "tc-1",
        message: "running",
      }, () => getState().liveTools[0]?.progressText === "running");

      await emitAndWait(act, source, {
        type: "tool_done",
        toolCallId: "tc-1",
        success: true,
        result: "done output",
      }, () => getState().liveTools[0]?.completedAt !== undefined);

      // Retained with its result; the view substitutes this onto the disk entry once that lands.
      expect(getState().liveTools).toMatchObject([
        { toolCallId: "tc-1", success: true, result: "done output" },
      ]);
    });

  });

  it("merges live sub-agent instructions and late responses onto the agent tool", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "tool_update",
        toolCallId: "agent-1",
        name: "🤖 Explore Agent",
        isSubAgent: true,
        args: { description: "Inspect scheduler tests" },
        agentInstructions: [
          { kind: "task", content: "Inspect the scheduler tests." },
          { kind: "follow_up", content: "Also check Windows." },
        ],
      }, () => getState().liveTools.length === 1);

      await emitAndWait(act, source, {
        type: "tool_update",
        toolCallId: "agent-1",
        name: "🤖 Explore Agent",
        isSubAgent: true,
        result: "The filesystem read races fake timers.",
        completedAt: "2026-07-24T10:00:04.000Z",
      }, () => getState().liveTools[0]?.result !== undefined);

      expect(getState().liveTools).toMatchObject([
        {
          toolCallId: "agent-1",
          args: { description: "Inspect scheduler tests" },
          agentInstructions: [
            { kind: "task", content: "Inspect the scheduler tests." },
            { kind: "follow_up", content: "Also check Windows." },
          ],
          result: "The filesystem read races fake timers.",
          completedAt: "2026-07-24T10:00:04.000Z",
        },
      ]);
    });
  });

  it("ignores hidden tools so they never affect run status", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await act(async () => {
        source.emit({ type: "tool_start", toolCallId: "tc-hidden", name: "task_complete" });
        source.emit({ type: "tool_start", toolCallId: "tc-intent", name: "report_intent" });
      });
      await waitTick();

      expect(getState().liveTools).toEqual([]);
    });
  });

  it("does not un-complete a finished tool from late progress events", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "tool_start",
        toolCallId: "tc-1",
        name: "bash",
      }, () => getState().liveTools.length === 1);
      await emitAndWait(act, source, {
        type: "tool_done",
        toolCallId: "tc-1",
        success: true,
      }, () => getState().liveTools[0]?.completedAt !== undefined);

      await act(async () => {
        source.emit({ type: "tool_progress", toolCallId: "tc-1", message: "late" });
      });
      await waitTick();

      // Late progress must not un-complete a finished tool.
      expect(getState().liveTools[0]?.completedAt).toBeDefined();
    });
  });

  it("stamps assistant segments with the source event id they will be committed under", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, { type: "delta", content: "partial " },
        () => getState().streamingContent === "partial ");
      await emitAndWait(act, source, {
        type: "assistant_partial",
        content: "partial answer",
        sourceEventId: "assistant-event-1",
        turnId: "provider-turn-1",
      }, () => getState().liveAssistantSegments.length === 1);

      expect(getState().streamingContent).toBe("");
      expect(getState().liveAssistantSegments[0]).toMatchObject({
        content: "partial answer",
        sourceEventId: "assistant-event-1",
        turnId: "provider-turn-1",
      });
    });
  });

  it("keeps bridge-native assistant output that events.jsonl will never contain", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "assistant_partial",
        content: "/context output",
        bridgeNative: true,
      }, () => getState().liveAssistantSegments.length === 1);

      expect(getState().liveAssistantSegments[0]?.sourceEventId).toBeUndefined();
      expect(getState().liveAssistantSegments[0]?.bridgeNative).toBe(true);

      // A new turn proves persisted segments reached disk; native output must survive it.
      await emitAndWait(act, source, {
        type: "assistant_partial",
        content: "persisted",
        sourceEventId: "assistant-1",
      }, () => getState().liveAssistantSegments.length === 2);
      await emitAndWait(act, source, { type: "thinking", turnId: "turn-2" },
        () => getState().liveAssistantSegments.length === 1);

      expect(getState().liveAssistantSegments[0]?.content).toBe("/context output");
    });
  });

  it("applies the pending user message lifecycle", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "user_message",
        userMessage: { id: "pending-1", content: "hello there", pending: true },
      }, () => getState().pendingUserMessages.length === 1);

      await emitAndWait(act, source, {
        type: "user_message_updated",
        userMessage: { id: "pending-1", content: "hello there, updated", pending: true },
      }, () => getState().pendingUserMessages[0]?.content === "hello there, updated");

      await emitAndWait(act, source, {
        type: "user_message_committed",
        id: "pending-1",
        sourceEventId: "user-event-1",
        timestamp: "2026-07-24T10:00:00.000Z",
      }, () => getState().pendingUserMessages[0]?.sourceEventId === "user-event-1");

      // The prompt stays on the stream after commit so the view can hand it off to disk history
      // by identity rather than dropping it into a gap.
      expect(getState().pendingUserMessages).toMatchObject([
        { id: "pending-1", sourceEventId: "user-event-1" },
      ]);

      await emitAndWait(act, source, {
        type: "user_message_discarded",
        id: "pending-1",
      }, () => getState().pendingUserMessages.length === 0);
    });
  });

  it("replaces the whole ephemeral overlay from reconnect snapshots", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, snapshot({
        streamingContent: "stale",
        liveTools: [{ toolCallId: "tc-stale", name: "bash" }],
      }), () => getState().liveTools.length === 1);

      await emitAndWait(act, source, snapshot({
        streamingContent: "",
        liveTools: [{ toolCallId: "tc-fresh", name: "view" }],
      }), () => getState().liveTools[0]?.toolCallId === "tc-fresh");

      expect(getState().liveTools).toHaveLength(1);
      expect(getState().streamingContent).toBe("");
    });
  });

  it("streams model thinking, closes it when the reply starts, and commits it by message id", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, { type: "thinking", turnId: "turn-1", turnInstanceId: "turn-start-1" },
        () => getState().streamStatus === "thinking");
      await emitAndWait(act, source, { type: "reasoning_delta", reasoningId: "r-1", content: "Nine remain, " },
        () => getState().liveReasoning.length === 1);
      await emitAndWait(act, source, { type: "reasoning_delta", reasoningId: "r-1", content: "then he doubles them." },
        () => getState().liveReasoning[0]?.content === "Nine remain, then he doubles them.");

      expect(getState().liveReasoning[0]).toMatchObject({ id: "r-1", turnId: "turn-1", turnInstanceId: "turn-start-1" });
      expect(getState().liveReasoning[0]?.completedAt).toBeUndefined();
      // Thinking is not output: the run is still waiting for its first visible text.
      expect(getState().streamStatus).toBe("thinking");
      expect(getState().hadVisibleOutput).toBe(false);

      await emitAndWait(act, source, { type: "delta", content: "Eighteen." },
        () => getState().liveReasoning[0]?.completedAt !== undefined);

      await emitAndWait(act, source, {
        type: "reasoning_committed",
        content: "Nine remain, then he doubles them.",
        sourceEventId: "assistant-message-1",
        timestamp: "2026-09-20T08:00:03.000Z",
      }, () => getState().liveReasoning[0]?.sourceEventId === "assistant-message-1");
      // The complete block arrives after the message that committed it and changes nothing.
      await act(async () => source.emit({ type: "reasoning", reasoningId: "r-1", content: "Nine remain, then he doubles them." }));

      expect(getState().liveReasoning).toMatchObject([{
        id: "r-1",
        sourceEventId: "assistant-message-1",
        committedAt: "2026-09-20T08:00:03.000Z",
      }]);

      // Its history read is usually still in flight when the next turn starts, so committed
      // thinking stays for one more turn; the view hides it as soon as disk history carries it.
      await emitAndWait(act, source, { type: "thinking", turnId: "turn-2", turnInstanceId: "turn-start-2" },
        () => getState().activeTurnInstanceId === "turn-start-2");
      expect(getState().liveReasoning.map((block) => block.id)).toEqual(["r-1"]);

      await emitAndWait(act, source, { type: "thinking", turnId: "turn-3", turnInstanceId: "turn-start-3" },
        () => getState().liveReasoning.length === 0);
    });
  });

  it("does not let a finished tool fall back to running when the next turn starts", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, { type: "thinking", turnId: "turn-1", turnInstanceId: "turn-start-1" },
        () => getState().activeTurnInstanceId === "turn-start-1");
      await emitAndWait(act, source, {
        type: "tool_start", toolCallId: "tc-done", name: "view", turnInstanceId: "turn-start-1", timestamp: "2026-09-20T08:00:01.000Z",
      }, () => getState().liveTools.length === 1);
      await emitAndWait(act, source, {
        type: "tool_start", toolCallId: "tc-open", name: "bash", turnInstanceId: "turn-start-1", timestamp: "2026-09-20T08:00:01.000Z",
      }, () => getState().liveTools.length === 2);
      await emitAndWait(act, source, {
        type: "tool_done", toolCallId: "tc-done", name: "view", turnInstanceId: "turn-start-1", success: true, result: "ok", timestamp: "2026-09-20T08:00:02.000Z",
      }, () => getState().liveTools.some((tool) => tool.toolCallId === "tc-done" && tool.completedAt !== undefined));

      // The disk read that carries the completion is still in flight here. Dropping the finished
      // tool now would hand the row back to a disk entry that still says "running".
      await emitAndWait(act, source, { type: "thinking", turnId: "turn-2", turnInstanceId: "turn-start-2" },
        () => getState().activeTurnInstanceId === "turn-start-2");
      expect(getState().liveTools).toMatchObject([{ toolCallId: "tc-done", success: true, result: "ok" }]);

      await emitAndWait(act, source, { type: "thinking", turnId: "turn-3", turnInstanceId: "turn-start-3" },
        () => getState().liveTools.length === 0);
    });
  });

  it("restores in-flight thinking from a reconnect snapshot and drops it if the run is cut short", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, snapshot({
        liveReasoning: [
          { id: "r-0", content: "committed thought", sourceEventId: "assistant-message-0", completedAt: "2026-09-20T08:00:00.000Z" },
          { id: "r-1", content: "still thinking", startedAt: "2026-09-20T08:00:01.000Z" },
          { id: "bad", content: 42 },
        ],
      }), () => getState().liveReasoning.length === 2);
      expect(getState().streamStatus).toBe("thinking");

      await emitAndWait(act, source, { type: "aborted", content: "" }, () => getState().streamStatus === "idle");

      expect(getState().liveReasoning.map((block) => block.id)).toEqual(["r-0"]);
    });
  });
});

describe("useSessionStream terminal handling", () => {
  it("closes and surfaces a bridge-native run notice on abort", async () => {
    await withHarness(async ({ getState, getSource, settled, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "aborted",
        content: "partial",
        runNotice: { kind: "stopped", timestamp: "2026-07-24T10:00:00.000Z" },
      }, () => getState().streamStatus === "idle");

      expect(source.close).toHaveBeenCalled();
      expect(settled).toHaveBeenCalled();
      expect(getState().runNotice).toMatchObject({ kind: "stopped" });
      expect(getState().liveTools).toEqual([]);
    });
  });

  it("surfaces an error notice and leaves the transcript to disk history", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "error",
        message: "boom",
        runNotice: { kind: "error", message: "boom" },
      }, () => getState().streamStatus === "idle");

      expect(getState().runNotice).toMatchObject({ kind: "error", message: "boom" });
    });
  });

  it("emits no notice for a normal done that disk history already covers", async () => {
    await withHarness(async ({ getState, getSource, titleChanged, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "done",
        content: "All set",
        sourceEventId: "terminal-1",
      }, () => getState().streamStatus === "idle");

      expect(getState().runNotice).toBeNull();
      expect(titleChanged).toHaveBeenCalled();
    });
  });

  it("bumps the history epoch on terminal so the view re-reads the final disk window", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      const before = getState().historyEpoch;

      await emitAndWait(act, source, { type: "done", content: "ok", sourceEventId: "t-1" },
        () => getState().streamStatus === "idle");

      expect(getState().historyEpoch).toBeGreaterThan(before);
    });
  });

  it("bumps the history epoch and clears live segments when history is truncated", async () => {
    await withHarness(async ({ getState, getSource, settled, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();
      await emitAndWait(act, source, {
        type: "assistant_partial",
        content: "before truncation",
        sourceEventId: "assistant-1",
      }, () => getState().liveAssistantSegments.length === 1);
      const before = getState().historyEpoch;

      await emitAndWait(act, source, { type: "history_truncated", eventsRemoved: 4 },
        () => getState().liveAssistantSegments.length === 0);

      expect(getState().historyEpoch).toBeGreaterThan(before);
      expect(settled).toHaveBeenCalled();
    });
  });

  it("replays a completed run from a terminal snapshot", async () => {
    await withHarness(async ({ getState, getSource, settled, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, snapshot({
        complete: true,
        terminalType: "aborted",
        runNotice: { kind: "stopped" },
      }), () => getState().streamStatus === "idle");

      expect(source.close).toHaveBeenCalled();
      expect(settled).toHaveBeenCalled();
      expect(getState().runNotice).toMatchObject({ kind: "stopped" });
    });
  });
});

describe("useSessionStream pending interactions", () => {
  it("hydrates and resolves pending interactions", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, snapshot({
        pendingUserInputs: [
          { requestId: "input-1", question: "Continue?", allowFreeform: true },
        ],
        pendingElicitations: [
          { requestId: "elicit-1", message: "Pick one", mode: "form", requestedSchema: { properties: {} } },
        ],
      }), () => getState().pendingUserInputs.length === 1);

      expect(getState().pendingElicitations).toHaveLength(1);

      await emitAndWait(act, source, { type: "user_input_answered", requestId: "input-1" },
        () => getState().pendingUserInputs.length === 0);
      await emitAndWait(act, source, { type: "elicitation_resolved", requestId: "elicit-1" },
        () => getState().pendingElicitations.length === 0);
    });
  });

  it("ignores a late cancellation after a locally resolved elicitation", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "elicitation_requested",
        requestId: "elicit-1",
        message: "Pick one",
        mode: "form",
        requestedSchema: { properties: {} },
      }, () => getState().pendingElicitations.length === 1);
      await emitAndWait(act, source, { type: "elicitation_resolved", requestId: "elicit-1" },
        () => getState().pendingElicitations.length === 0);

      await act(async () => {
        source.emit({ type: "elicitation_canceled", requestId: "elicit-1", reason: "superseded" });
      });
      await waitTick();

      expect(getState().elicitationCancellation).toBeNull();
    });
  });

  it("surfaces pending elicitation cancellation when a run aborts", async () => {
    await withHarness(async ({ getState, getSource, act }) => {
      await act(async () => getState().reconnect("session-1"));
      const source = getSource();

      await emitAndWait(act, source, {
        type: "elicitation_requested",
        requestId: "elicit-1",
        message: "Pick one",
        mode: "form",
        requestedSchema: { properties: {} },
      }, () => getState().pendingElicitations.length === 1);

      await emitAndWait(act, source, { type: "aborted", content: "" },
        () => getState().streamStatus === "idle");

      expect(getState().elicitationCancellation).toMatchObject({
        requestId: "elicit-1",
        question: "Pick one",
      });
    });
  });
});

describe("stream helpers", () => {
  it("keeps known tool names, rejects placeholders, normalizes live tools, and drops hidden ones", () => {
    expect(getKnownToolName("bash")).toBe("bash");
    expect(getKnownToolName("unknown")).toBeUndefined();
    expect(getKnownToolName("  ")).toBeUndefined();
    expect(getKnownToolName(42)).toBeUndefined();

    const tools = normalizeLiveTools([
      { toolCallId: "tc-1", name: "bash" },
      { toolCallId: "tc-2", name: "task_complete" },
      { toolCallId: "", name: "grep" },
      { toolCallId: "tc-3", name: "session_rename", args: { sessionId: "session-1" } },
    ], "session-1", "turn-1", "turn-instance-1");

    expect(tools).toMatchObject([
      { toolCallId: "tc-1", name: "bash", turnId: "turn-1", turnInstanceId: "turn-instance-1" },
    ]);
  });

  it("merges tool patches without losing earlier metadata", () => {
    const merged = upsertLiveTool(
      [{
        toolCallId: "tc-1",
        name: "bash",
        args: { command: "ls" },
        agentInstructions: [{ kind: "task", content: "Inspect it" }],
        startedAt: "t0",
      }],
      { toolCallId: "tc-1", name: "unknown", progressText: "running" },
    );

    expect(merged).toMatchObject([
      {
        toolCallId: "tc-1",
        name: "bash",
        args: { command: "ls" },
        agentInstructions: [{ kind: "task", content: "Inspect it" }],
        startedAt: "t0",
        progressText: "running",
      },
    ]);
  });

  it("keeps the ending turn's disk-backed segments for one more turn, and native ones always", () => {
    const segments = [
      { id: "old", content: "two turns ago", sourceEventId: "old", turnInstanceId: "turn-a" },
      { id: "a", content: "just persisted", sourceEventId: "a", turnInstanceId: "turn-b" },
      // An SDK event without an id can never be matched against disk, so it is not kept.
      { id: "b", content: "sdk without id", turnInstanceId: "turn-b" },
      { id: "c", content: "native", bridgeNative: true },
    ];

    // Its history read is usually still in flight when the next turn starts.
    expect(retireSegmentsAtTurnBoundary(segments, "turn-b")).toMatchObject([{ id: "a" }, { id: "c" }]);
    // Without a known ending turn nothing disk-backed can be kept safely.
    expect(retireSegmentsAtTurnBoundary(segments, undefined)).toMatchObject([{ id: "c" }]);
  });

  it("normalizes run notices and rejects unknown kinds", () => {
    expect(normalizeRunNotice({ kind: "stopped" })).toMatchObject({ kind: "stopped" });
    expect(normalizeRunNotice(Object.assign([], { kind: "stopped" }))).toBeNull();
    expect(normalizeRunNotice({ kind: "nonsense" })).toBeNull();
    expect(normalizeRunNotice(null)).toBeNull();
  });
});
