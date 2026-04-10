import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";

describe("SessionManager visible activity cache", () => {
  let copilotHome: string;

  beforeEach(() => {
    copilotHome = mkdtempSync(join(tmpdir(), "bridge-visible-activity-"));
  });

  afterEach(() => {
    rmSync(copilotHome, { recursive: true, force: true });
  });

  function createManager() {
    const db = setupTestDb();
    return new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {} as any,
      config: { sessionMcpServers: {} },
      copilotHome,
    });
  }

  function writeSession(events: any[]) {
    const sessionDir = join(copilotHome, "session-state", "session-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), "created_at: 2026-04-10T09:59:00.000Z\nsummary: Visible activity test\n");
    writeFileSync(join(sessionDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    return join(sessionDir, "events.jsonl");
  }

  it("reuses cached visible activity when the log mtime is unchanged", async () => {
    const eventsPath = writeSession([
      { type: "assistant.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Done" } },
    ]);
    const manager = createManager();

    const initial = await manager.listSessionsFromDisk();
    expect(initial[0]?.lastVisibleActivityAt).toBe("2026-04-10T10:00:00.000Z");

    chmodSync(eventsPath, 0o000);
    try {
      const cached = await manager.listSessionsFromDisk();
      expect(cached[0]?.lastVisibleActivityAt).toBe("2026-04-10T10:00:00.000Z");
    } finally {
      chmodSync(eventsPath, 0o644);
    }
  });

  it("refreshes visible activity when the log mtime changes", async () => {
    writeSession([
      { type: "assistant.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Done" } },
    ]);
    const manager = createManager();

    const initial = await manager.listSessionsFromDisk();
    expect(initial[0]?.lastVisibleActivityAt).toBe("2026-04-10T10:00:00.000Z");

    writeSession([
      { type: "assistant.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Done" } },
      { type: "assistant.turn_end", timestamp: "2026-04-10T10:00:01.000Z", data: {} },
      { type: "assistant.message", timestamp: "2026-04-10T10:05:00.000Z", data: { content: "Another reply" } },
    ]);

    const updated = await manager.listSessionsFromDisk();
    expect(updated[0]?.lastVisibleActivityAt).toBe("2026-04-10T10:05:00.000Z");
  });
});
