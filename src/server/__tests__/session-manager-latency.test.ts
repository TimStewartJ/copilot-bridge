import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createTestBus, makeTestDir, setupTestDb } from "./helpers.js";

function createManager(copilotHome: string) {
  const db = setupTestDb();
  const telemetryStore = createTelemetryStore(db);
  const manager = new SessionManager({
    tools: [],
    globalBus: createTestBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    sessionMetaStore: createSessionMetaStore(db),
    taskStore: {
      findTaskBySessionId: vi.fn().mockReturnValue(null),
    } as any,
    settingsStore: {
      getMcpServers: () => ({}),
      getSettings: () => ({ mcpServers: {} }),
    } as any,
    telemetryStore,
    config: { sessionMcpServers: {} },
    copilotHome,
  }) as any;
  return { manager, telemetryStore };
}

function writeSession(copilotHome: string, sessionId: string, summary: string) {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "workspace.yaml"),
    `created_at: 2026-04-30T10:00:00.000Z\nsummary: ${summary}\n`,
  );
  writeFileSync(
    join(sessionDir, "events.jsonl"),
    `${JSON.stringify({
      type: "user.message",
      timestamp: "2026-04-30T10:00:01.000Z",
      data: { content: summary },
    })}\n`,
  );
}

describe("SessionManager disk session list cache", () => {
  it("coalesces concurrent disk scans and serves fresh cache hits", async () => {
    const copilotHome = makeTestDir("session-manager-list-cache");
    writeSession(copilotHome, "session-a", "Alpha");
    writeSession(copilotHome, "session-b", "Beta");
    const { manager, telemetryStore } = createManager(copilotHome);

    const [first, second] = await Promise.all([
      manager.listSessionsFromDisk({ includeArchived: false }),
      manager.listSessionsFromDisk({ includeArchived: false }),
    ]);
    const third = await manager.listSessionsFromDisk({ includeArchived: false });

    expect(first.map((session: any) => session.sessionId).sort()).toEqual(["session-a", "session-b"]);
    expect(second).toBe(first);
    expect(third).toBe(first);

    const cacheResults = telemetryStore
      .querySpans({ name: "session.listFromDisk.cache", limit: 20 })
      .map((span) => span.metadata?.result);
    expect(cacheResults).toEqual(expect.arrayContaining(["miss", "coalesced", "hit"]));
  });
});
