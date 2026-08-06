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
});
