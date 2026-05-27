import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../session-manager.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus, createTestApp } from "./helpers.js";

class MigrationTestSessionManager extends SessionManager {
  readonly setCalls: Array<{ sessionId: string; name: string; opts: any }> = [];

  override async setSessionName(sessionId: string, name: string, opts: any = {}): Promise<void> {
    this.setCalls.push({ sessionId, name, opts });
  }
}

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

  it("does not inject automatic session rename guidance", () => {
    const { tool } = createRenameToolHarness();
    expect(tool.description).toContain("Rename a chat session");
    expect(vi.isMockFunction(tool.handler)).toBe(false);
  });

  it("migrates legacy Bridge titles only for sessions without existing CLI names", async () => {
    const { ctx, db } = createTestApp();
    const writeWorkspace = (sessionId: string, content: string) => {
      const sessionDir = join(ctx.copilotHome!, "session-state", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "workspace.yaml"), content);
    };
    writeWorkspace("needs-migration", "created_at: 2026-05-01T10:00:00.000Z\n");
    writeWorkspace("already-named", "created_at: 2026-05-01T10:00:00.000Z\nname: CLI name\n");
    db.exec(`
      CREATE TABLE session_titles (
        sessionId TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO session_titles (sessionId, title) VALUES (?, ?)")
      .run("needs-migration", "Legacy Bridge Name");
    db.prepare("INSERT INTO session_titles (sessionId, title) VALUES (?, ?)")
      .run("already-named", "Legacy Should Not Win");

    const manager = new MigrationTestSessionManager({
      globalBus: ctx.globalBus,
      eventBusRegistry: ctx.eventBusRegistry,
      sessionTitles: ctx.sessionTitles,
      sessionWorkspaceStore: ctx.sessionWorkspaceStore,
      sessionMetaStore: ctx.sessionMetaStore,
      taskStore: ctx.taskStore,
      taskGroupStore: ctx.taskGroupStore,
      checklistStore: ctx.checklistStore,
      settingsStore: ctx.settingsStore,
      tagStore: ctx.tagStore,
      mcpServerStore: ctx.mcpServerStore,
      docsIndex: ctx.docsIndex,
      docsStore: ctx.docsStore,
      config: { sessionMcpServers: {} },
      telemetryStore: ctx.telemetryStore,
      copilotHome: ctx.copilotHome,
      runtimePaths: ctx.runtimePaths,
    } as any);

    await manager.migrateLegacySessionTitles();

    expect(manager.setCalls).toEqual([
      { sessionId: "needs-migration", name: "Legacy Bridge Name", opts: { emit: false } },
    ]);
    expect(ctx.sessionTitles.getAllTitles()).toEqual({});
    expect(() => db.prepare("SELECT * FROM session_titles").all()).toThrow();
  });
});
