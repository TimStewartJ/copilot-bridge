import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTestBus, makeAgentSessionStub, setupTestDb } from "./helpers.js";
import { transformEventsToMessages } from "../event-transform.js";

describe("SessionManager tool result rendering", () => {
  let eventBusRegistry: ReturnType<typeof createEventBusRegistry>;
  let sessionTitles: ReturnType<typeof createSessionTitlesStore>;
  let globalBus: ReturnType<typeof createTestBus>;

  beforeEach(() => {
    const db = setupTestDb();
    eventBusRegistry = createEventBusRegistry();
    sessionTitles = createSessionTitlesStore(db);
    globalBus = createTestBus();
  });

  function createManager() {
    return new SessionManager({
      globalBus,
      eventBusRegistry,
      sessionTitles,
      taskStore: { findTaskBySessionId: () => undefined } as any,
      config: { sessionMcpServers: {} },
    });
  }

  function createSession(events: any[]) {
    const handlers: Array<(event: any) => void> = [];
    return makeAgentSessionStub({
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on(handler: (event: any) => void) {
        handlers.push(handler);
        return () => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
      send: vi.fn(async () => {
        queueMicrotask(() => {
          for (const event of events) {
            for (const handler of [...handlers]) handler(event);
          }
        });
      }),
    });
  }

  it("streams detailed results, sub-agent responses, and failed tool errors", async () => {
    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const events: any[] = [];

    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    const session = createSession([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-success", toolName: "bash", arguments: { command: "git diff" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tool-success",
          success: true,
          result: { content: "short summary", detailedContent: "full diff output" },
        },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { toolCallId: "tool-agent", toolName: "task", arguments: { prompt: "Investigate" } },
      },
      {
        type: "subagent.started",
        timestamp: "2026-04-10T10:00:03.000Z",
        data: { toolCallId: "tool-agent", agentName: "explore", agentDisplayName: "Explore agent" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T10:00:04.000Z",
        data: { parentToolCallId: "tool-agent", content: "Agent summary" },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:05.000Z",
        data: {
          toolCallId: "tool-agent",
          success: true,
          result: { content: "short summary", detailedContent: "full detailed output" },
        },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:06.000Z",
        data: { toolCallId: "tool-failure", toolName: "browser_fetch", arguments: { url: "https://example.com" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:07.000Z",
        data: {
          toolCallId: "tool-failure",
          success: false,
          error: { message: "Snapshot failed" },
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T10:00:08.000Z",
        data: { content: "Done." },
      },
      { type: "session.idle", timestamp: "2026-04-10T10:00:09.000Z", data: {} },
    ]);

    manager.backend = {} as any;
    manager.sessionObjects.set("session-1", session);

    await manager._doWork("session-1", "show tool results", bus);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_done",
      toolCallId: "tool-success",
      name: "bash",
      result: "full diff output",
      success: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_update",
      toolCallId: "tool-agent",
      name: "🤖 Explore agent",
      isSubAgent: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_done",
      toolCallId: "tool-agent",
      name: "🤖 Explore agent",
      result: "Agent summary",
      success: true,
      isSubAgent: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_done",
      toolCallId: "tool-failure",
      name: "browser_fetch",
      result: "Snapshot failed",
      success: false,
    }));
  });

  it("renders runtime failure text when handlers omit the ToolResultObject error field", async () => {
    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-2");
    const events: any[] = [];

    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    const session = createSession([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T11:00:00.000Z",
        data: { toolCallId: "tool-failure-detail", toolName: "browser_fetch", arguments: { url: "https://example.com" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T11:00:01.000Z",
        data: {
          toolCallId: "tool-failure-detail",
          success: false,
          error: {
            message: "Failed to capture page: snapshot failed",
          },
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T11:00:02.000Z",
        data: { content: "Done." },
      },
      { type: "session.idle", timestamp: "2026-04-10T11:00:03.000Z", data: {} },
    ]);

    manager.backend = {} as any;
    manager.sessionObjects.set("session-2", session);

    await manager._doWork("session-2", "show failed tool results", bus);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_done",
      toolCallId: "tool-failure-detail",
      name: "browser_fetch",
      result: "Failed to capture page: snapshot failed",
      success: false,
    }));
  });

  it("uses tracked tool and sub-agent names for progress and partial output events", async () => {
    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-3");
    const events: any[] = [];

    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    const session = createSession([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T12:00:00.000Z",
        data: { toolCallId: "tool-progress", toolName: "bash", arguments: { command: "npm test" } },
      },
      {
        type: "tool.execution_progress",
        timestamp: "2026-04-10T12:00:01.000Z",
        data: { toolCallId: "tool-progress", progressMessage: "Running tests..." },
      },
      {
        type: "tool.execution_partial_result",
        timestamp: "2026-04-10T12:00:02.000Z",
        data: { toolCallId: "tool-progress", partialOutput: "12 tests passed" },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T12:00:03.000Z",
        data: { toolCallId: "tool-agent-progress", toolName: "task", arguments: { prompt: "Investigate" } },
      },
      {
        type: "subagent.started",
        timestamp: "2026-04-10T12:00:04.000Z",
        data: { toolCallId: "tool-agent-progress", agentName: "explore", agentDisplayName: "Explore agent" },
      },
      {
        type: "tool.execution_progress",
        timestamp: "2026-04-10T12:00:05.000Z",
        data: { toolCallId: "tool-agent-progress", progressMessage: "Searching files..." },
      },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T12:00:06.000Z",
        data: { content: "Done." },
      },
      { type: "session.idle", timestamp: "2026-04-10T12:00:07.000Z", data: {} },
    ]);

    manager.backend = {} as any;
    manager.sessionObjects.set("session-3", session);

    await manager._doWork("session-3", "show progress labels", bus);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_progress",
      toolCallId: "tool-progress",
      name: "bash",
      message: "Running tests...",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_output",
      toolCallId: "tool-progress",
      name: "bash",
      content: "12 tests passed",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_progress",
      toolCallId: "tool-agent-progress",
      name: "🤖 Explore agent",
      message: "Searching files...",
    }));
  });
  it("streams the real sub-agent failure reason and matches disk replay", async () => {
    // The live fold and the disk replay fold are separate traversals of the same event stream.
    // They must agree, so this drives both from one event list and compares the results.
    const sdkEvents: any[] = [
      {
        type: "tool.execution_start",
        timestamp: "2026-08-01T10:00:00.000Z",
        data: { toolCallId: "call_sync_agent", toolName: "task", arguments: { mode: "sync" } },
      },
      {
        type: "subagent.started",
        agentId: "subagent_instance_7",
        timestamp: "2026-08-01T10:00:00.100Z",
        data: { toolCallId: "call_sync_agent", agentName: "explore", agentDisplayName: "Explore Agent" },
      },
      {
        type: "subagent.failed",
        timestamp: "2026-08-01T10:00:04.000Z",
        data: { toolCallId: "call_sync_agent", error: "CAPIError: 400 messages: at least one message is required" },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-08-01T10:00:04.100Z",
        data: {
          toolCallId: "call_sync_agent",
          success: false,
          error: { message: "Agent completed but produced no response.", code: "failure" },
        },
      },
      { type: "session.idle", timestamp: "2026-08-01T10:00:05.000Z", data: {} },
    ];

    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-subagent-failure");
    const events: any[] = [];
    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    manager.backend = {} as any;
    manager.sessionObjects.set("session-subagent-failure", createSession(sdkEvents));
    await manager._doWork("session-subagent-failure", "run an agent", bus);

    const liveDone = events.find((event) => event.type === "tool_done" && event.toolCallId === "call_sync_agent");
    expect(liveDone).toMatchObject({
      name: "🤖 Explore Agent",
      result: "CAPIError: 400 messages: at least one message is required",
      success: false,
      isSubAgent: true,
    });

    const replayed = transformEventsToMessages(sdkEvents).find((entry) => entry.type === "tool");
    expect(replayed?.toolCall).toMatchObject({
      name: liveDone.name,
      result: liveDone.result,
      success: liveDone.success,
      isSubAgent: liveDone.isSubAgent,
    });
  });

  it("keeps a background agent launch successful in both folds when the agent fails later", async () => {
    // The launch itself succeeded. The live fold has no look-ahead, so replay must not use its
    // look-ahead to retroactively fail the launch.
    const sdkEvents: any[] = [
      {
        type: "tool.execution_start",
        timestamp: "2026-08-01T11:00:00.000Z",
        data: { toolCallId: "call_bg_agent", toolName: "task", arguments: { mode: "background" } },
      },
      {
        type: "subagent.started",
        agentId: "subagent_instance_8",
        timestamp: "2026-08-01T11:00:00.100Z",
        data: { toolCallId: "call_bg_agent", agentName: "explore", agentDisplayName: "Explore Agent" },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-08-01T11:00:00.200Z",
        data: {
          toolCallId: "call_bg_agent",
          success: true,
          result: { content: "Agent started in background" },
        },
      },
      {
        type: "subagent.failed",
        timestamp: "2026-08-01T11:20:00.000Z",
        data: { toolCallId: "call_bg_agent", error: "CAPIError: 404 Not Found" },
      },
      { type: "session.idle", timestamp: "2026-08-01T11:20:01.000Z", data: {} },
    ];

    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-background-agent");
    const events: any[] = [];
    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    manager.backend = {} as any;
    manager.sessionObjects.set("session-background-agent", createSession(sdkEvents));
    await manager._doWork("session-background-agent", "run a background agent", bus);

    const liveDone = events.find((event) => event.type === "tool_done" && event.toolCallId === "call_bg_agent");
    expect(liveDone).toMatchObject({ result: "Agent started in background", success: true });

    const replayed = transformEventsToMessages(sdkEvents).find((entry) => entry.type === "tool");
    expect(replayed?.toolCall).toMatchObject({
      result: liveDone.result,
      success: liveDone.success,
    });
  });

  it("streams sub-agent instructions and late responses onto the agent tool", async () => {
    const initialPrompt = "Inspect the scheduler tests.";
    const followUp = "Also check Windows behavior.";
    const sdkEvents: any[] = [
      {
        type: "assistant.turn_start",
        timestamp: "2026-08-01T11:59:59.000Z",
        data: { turnId: "parent-turn" },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-08-01T12:00:00.000Z",
        data: {
          toolCallId: "call_bg_agent_thread",
          toolName: "task",
          arguments: {
            description: "Inspect scheduler tests",
            prompt: initialPrompt,
            mode: "background",
          },
        },
      },
      {
        type: "subagent.started",
        agentId: "subagent_thread_1",
        timestamp: "2026-08-01T12:00:00.100Z",
        data: {
          toolCallId: "call_bg_agent_thread",
          agentName: "explore",
          agentDisplayName: "Explore Agent",
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-08-01T12:00:00.200Z",
        data: {
          toolCallId: "call_bg_agent_thread",
          success: true,
          result: { content: "Agent started in background" },
        },
      },
      {
        type: "assistant.turn_end",
        timestamp: "2026-08-01T12:00:00.300Z",
        data: { turnId: "parent-turn" },
      },
      {
        type: "assistant.turn_start",
        timestamp: "2026-08-01T12:00:00.400Z",
        data: { turnId: "child-turn" },
      },
      {
        type: "user.message",
        agentId: "subagent_thread_1",
        timestamp: "2026-08-01T12:00:01.000Z",
        data: {
          content: initialPrompt,
          source: "agent-parent-session",
          parentAgentTaskId: "task-1",
        },
      },
      {
        type: "user.message",
        agentId: "subagent_thread_1",
        timestamp: "2026-08-01T12:00:02.000Z",
        data: {
          content: followUp,
          source: "agent-parent-session",
          parentAgentTaskId: "task-1",
        },
      },
      {
        type: "assistant.message",
        agentId: "subagent_thread_1",
        timestamp: "2026-08-01T12:00:03.000Z",
        data: {
          parentToolCallId: "call_bg_agent_thread",
          content: "The filesystem read races fake timers.",
        },
      },
      {
        type: "subagent.completed",
        agentId: "subagent_thread_1",
        timestamp: "2026-08-01T12:00:04.000Z",
        data: { toolCallId: "call_bg_agent_thread" },
      },
      {
        type: "assistant.turn_end",
        timestamp: "2026-08-01T12:00:04.500Z",
        data: { turnId: "child-turn" },
      },
      { type: "session.idle", timestamp: "2026-08-01T12:00:05.000Z", data: {} },
    ];

    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-agent-thread");
    const events: any[] = [];
    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    manager.backend = {} as any;
    manager.sessionObjects.set("session-agent-thread", createSession(sdkEvents));
    await manager._doWork("session-agent-thread", "run a background agent", bus);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_update",
      toolCallId: "call_bg_agent_thread",
      agentInstructions: [
        { kind: "task", content: initialPrompt },
        { kind: "follow_up", content: followUp },
      ],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_update",
      toolCallId: "call_bg_agent_thread",
      result: "The filesystem read races fake timers.",
    }));
    expect(events.filter((event) => event.type === "thinking")).toHaveLength(1);
  });

  it("keeps a finished agent's name when the runtime reports its end a second time", async () => {
    // The order a real sync sub-agent produced: its end, the launching call's completion, then the
    // same end again, after the correlation for that call has been dropped.
    const sdkEvents = [
      { id: "turn-start-1", type: "assistant.turn_start", timestamp: "2026-09-20T16:29:06.670Z", data: { turnId: "1" } },
      {
        type: "tool.execution_start",
        timestamp: "2026-09-20T16:29:17.578Z",
        data: { toolCallId: "task-1", toolName: "task", arguments: { description: "Find cache version constant", prompt: "Find it." } },
      },
      {
        type: "subagent.started",
        agentId: "agent-1",
        timestamp: "2026-09-20T16:29:17.598Z",
        data: { toolCallId: "task-1", agentName: "explore", agentDisplayName: "find-cache-version" },
      },
      {
        type: "assistant.message",
        agentId: "agent-1",
        timestamp: "2026-09-20T16:29:21.600Z",
        data: { parentToolCallId: "task-1", content: "It is 4." },
      },
      { type: "subagent.completed", agentId: "agent-1", timestamp: "2026-09-20T16:29:21.693Z", data: { toolCallId: "task-1" } },
      {
        type: "tool.execution_complete",
        timestamp: "2026-09-20T16:29:22.020Z",
        data: { toolCallId: "task-1", success: true, result: { content: "Agent completed." } },
      },
      { type: "subagent.completed", agentId: "agent-1", timestamp: "2026-09-20T16:29:22.040Z", data: { toolCallId: "task-1" } },
      { type: "assistant.message", timestamp: "2026-09-20T16:29:29.000Z", data: { content: "Done." } },
      { type: "session.idle", timestamp: "2026-09-20T16:29:29.482Z", data: {} },
    ];

    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-agent-repeat-end");
    const events: any[] = [];
    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    manager.backend = {} as any;
    manager.sessionObjects.set("session-agent-repeat-end", createSession(sdkEvents));
    await manager._doWork("session-agent-repeat-end", "find the constant", bus);

    const names = events
      .filter((event) => event.toolCallId === "task-1" && event.type !== "tool_start")
      .map((event) => [event.type, event.name]);
    // Every update after the agent identified itself carries its name; none falls back to "task".
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.every(([, name]) => name === "🤖 find-cache-version")).toBe(true);
    // What a client that reconnects at the end is given.
    expect(bus.getSnapshot().liveTools).toMatchObject([{
      toolCallId: "task-1",
      name: "🤖 find-cache-version",
      isSubAgent: true,
      success: true,
      result: "It is 4.",
    }]);
  });

  it("streams the main agent's thinking and commits it under its assistant message", async () => {
    // The order the runtime really uses: deltas, then the persisted message carrying the same
    // text as `reasoningText`, then the ephemeral complete block.
    const sdkEvents = [
      {
        id: "turn-start-1",
        type: "assistant.turn_start",
        timestamp: "2026-09-20T08:00:00.000Z",
        data: { turnId: "0" },
      },
      {
        type: "assistant.reasoning_delta",
        ephemeral: true,
        timestamp: "2026-09-20T08:00:01.000Z",
        data: { reasoningId: "reasoning-1", deltaContent: "Nine remain, " },
      },
      {
        type: "assistant.reasoning_delta",
        ephemeral: true,
        timestamp: "2026-09-20T08:00:01.100Z",
        data: { reasoningId: "reasoning-1", deltaContent: "then he doubles them." },
      },
      {
        type: "assistant.reasoning_delta",
        ephemeral: true,
        agentId: "agent-1",
        timestamp: "2026-09-20T08:00:01.200Z",
        data: { reasoningId: "reasoning-sub", deltaContent: "sub-agent thinking" },
      },
      {
        type: "assistant.message_delta",
        ephemeral: true,
        timestamp: "2026-09-20T08:00:02.000Z",
        data: { deltaContent: "Eighteen." },
      },
      {
        id: "assistant-message-1",
        type: "assistant.message",
        timestamp: "2026-09-20T08:00:03.000Z",
        data: { content: "Eighteen.", reasoningText: "Nine remain, then he doubles them." },
      },
      {
        type: "assistant.reasoning",
        ephemeral: true,
        timestamp: "2026-09-20T08:00:03.100Z",
        data: { reasoningId: "reasoning-1", content: "Nine remain, then he doubles them." },
      },
      {
        id: "sub-message-1",
        type: "assistant.message",
        agentId: "agent-1",
        timestamp: "2026-09-20T08:00:03.200Z",
        data: { content: "", reasoningText: "sub-agent thinking" },
      },
      { type: "session.idle", timestamp: "2026-09-20T08:00:04.000Z", data: {} },
    ];

    const manager = createManager() as any;
    const bus = eventBusRegistry.getOrCreateBus("session-thinking");
    const events: any[] = [];
    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });

    manager.backend = {} as any;
    manager.sessionObjects.set("session-thinking", createSession(sdkEvents));
    await manager._doWork("session-thinking", "how many sheep", bus);

    const reasoningEvents = events.filter((event) => String(event.type).startsWith("reasoning"));
    // The complete block the runtime sends last repeats what was just committed, so it is folded
    // and not rebroadcast.
    expect(reasoningEvents.map((event) => [event.type, event.content])).toEqual([
      ["reasoning_delta", "Nine remain, "],
      ["reasoning_delta", "then he doubles them."],
      ["reasoning_committed", "Nine remain, then he doubles them."],
    ]);
    expect(reasoningEvents[0]).toMatchObject({
      reasoningId: "reasoning-1",
      turnId: "0",
      turnInstanceId: "turn-start-1",
    });
    expect(reasoningEvents[2]).toMatchObject({ sourceEventId: "assistant-message-1" });
    // The thinking is committed before the reply it preceded, the order the transcript shows them.
    const types = events.map((event) => event.type);
    expect(types.indexOf("reasoning_committed")).toBeLessThan(types.indexOf("assistant_partial"));
    // One block, owned by disk, survives to the end of the run.
    expect(bus.getSnapshot().liveReasoning).toMatchObject([{
      id: "reasoning-1",
      content: "Nine remain, then he doubles them.",
      sourceEventId: "assistant-message-1",
    }]);
  });
});
