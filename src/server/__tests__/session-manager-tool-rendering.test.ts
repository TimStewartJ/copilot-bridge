import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTestBus, setupTestDb } from "./helpers.js";

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
      tools: [],
      globalBus,
      eventBusRegistry,
      sessionTitles,
      taskStore: { findTaskBySessionId: () => undefined } as any,
      config: { sessionMcpServers: {} },
    });
  }

  function createSession(events: any[]) {
    const handlers: Array<(event: any) => void> = [];
    return {
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
    };
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
});
