import { describe, expect, it, vi } from "vitest";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";

describe("session CLI renames", () => {
  function createRenameToolHarness() {
    const db = setupTestDb();
    const eventBusRegistry = createEventBusRegistry();
    const sessionTitles = createSessionTitlesStore(db);
    const globalBus = createTestBus();
    const setSessionName = vi.fn(async (sessionId: string, title: string) => {
      eventBusRegistry.getBus(sessionId)?.emit({ type: "title_changed", title });
      globalBus.emit({ type: "session:title", sessionId, title });
    });
    const tool = getBridgeToolDefinitions({
      taskStore: { findTaskBySessionId: () => undefined } as any,
      taskGroupStore: {} as any,
      scheduleStore: {} as any,
      settingsStore: undefined,
      sessionMetaStore: {} as any,
      sessionTitles,
      readStateStore: {} as any,
      checklistStore: {} as any,
      tagStore: undefined,
      telemetryStore: undefined,
      docsStore: undefined,
      docsIndex: undefined,
      globalBus,
      eventBusRegistry,
      sessionManager: { evictAllCachedSessions() {}, setSessionName } as any,
    } as any).find((candidate) => candidate.name === "session_rename");
    if (!tool) throw new Error("session_rename tool not found");
    return { tool, eventBusRegistry, sessionTitles, globalBus, setSessionName };
  }

  it("defaults session_rename to the invoking session and delegates to CLI-owned rename", async () => {
    const { tool, eventBusRegistry, sessionTitles, globalBus, setSessionName } = createRenameToolHarness();
    const sessionBus = eventBusRegistry.getOrCreateBus("session-1");
    const busEvents: any[] = [];
    const globalEvents: any[] = [];
    sessionBus.subscribe((event) => {
      if (event.type !== "snapshot") busEvents.push(event);
    });
    globalBus.subscribe((event) => globalEvents.push(event));

    const result = await tool.handler(
      { title: "Project sync follow-up" },
      { sessionId: "session-1", toolCallId: "tool-1", toolName: "session_rename", arguments: { title: "Project sync follow-up" } },
    );

    expect(result).toMatchObject({
      success: true,
      sessionId: "session-1",
      message: 'Session renamed to "Project sync follow-up"',
    });
    expect(setSessionName).toHaveBeenCalledWith("session-1", "Project sync follow-up");
    expect(sessionTitles.getTitle("session-1")).toBeUndefined();
    expect(busEvents).toContainEqual({ type: "title_changed", title: "Project sync follow-up" });
    expect(globalEvents).toContainEqual({
      type: "session:title",
      sessionId: "session-1",
      title: "Project sync follow-up",
    });
  });

  it("respects an explicit target session id", async () => {
    const { tool, eventBusRegistry, sessionTitles, setSessionName } = createRenameToolHarness();
    const targetBus = eventBusRegistry.getOrCreateBus("target-session");
    const targetEvents: any[] = [];
    targetBus.subscribe((event) => {
      if (event.type !== "snapshot") targetEvents.push(event);
    });

    await tool.handler(
      { sessionId: "target-session", title: "Renamed elsewhere" },
      { sessionId: "caller-session", toolCallId: "tool-2", toolName: "session_rename", arguments: { sessionId: "target-session", title: "Renamed elsewhere" } },
    );

    expect(sessionTitles.getTitle("caller-session")).toBeUndefined();
    expect(sessionTitles.getTitle("target-session")).toBeUndefined();
    expect(setSessionName).toHaveBeenCalledWith("target-session", "Renamed elsewhere");
    expect(targetEvents).toContainEqual({ type: "title_changed", title: "Renamed elsewhere" });
  });
});
