import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../session-manager.js";
import { setupTestDb, createTestBus, makeTestDir } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createSessionMetaStore } from "../session-meta-store.js";

const readFileCallMock = vi.hoisted(() => vi.fn<(path: string) => void>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { readFileSync } = await import("node:fs");
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0], _encoding: BufferEncoding) => {
      readFileCallMock(String(path));
      return readFileSync(path as string, "utf-8");
    },
  };
});

describe("SessionManager visible activity cache", () => {
  let copilotHome: string;

  beforeEach(() => {
    readFileCallMock.mockReset();
    copilotHome = makeTestDir("visible-activity");
  });


  function createManager() {
    const db = setupTestDb();
    const sessionMetaStore = createSessionMetaStore(db);
    const dataDir = join(copilotHome, "data");
    const manager = new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      sessionMetaStore,
      taskStore: {} as any,
      config: { sessionMcpServers: {} },
      copilotHome,
      runtimePaths: {
        demoMode: false,
        dataDir,
        docsDir: join(dataDir, "docs"),
        copilotHome,
        env: process.env,
      },
    });
    return { manager, sessionMetaStore };
  }

  function writeSession(events: any[], opts: { sessionId?: string; createdAt?: string } = {}) {
    const sessionId = opts.sessionId ?? "session-1";
    const createdAt = opts.createdAt ?? "2026-04-10T09:59:00.000Z";
    const sessionDir = join(copilotHome, "session-state", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), `created_at: ${createdAt}\nsummary: Visible activity test\n`);
    writeFileSync(join(sessionDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    return join(sessionDir, "events.jsonl");
  }

  function countReads(path: string): number {
    return readFileCallMock.mock.calls.filter(([readPath]) => readPath === path).length;
  }

  it("uses persisted visible activity without reading the event log", async () => {
    const eventsPath = writeSession([
      { type: "assistant.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Done" } },
      { type: "assistant.message", timestamp: "2026-04-10T10:05:00.000Z", data: { content: "Newer log activity" } },
    ]);
    const { manager, sessionMetaStore } = createManager();
    sessionMetaStore.setLastVisibleActivityAt("session-1", "2026-04-10T10:00:00.000Z");

    const sessions = await manager.listSessionsFromDisk();

    expect(sessions[0]?.lastVisibleActivityAt).toBe("2026-04-10T10:00:00.000Z");
    expect(sessions[0]?.modifiedTime).toBe("2026-04-10T10:00:00.000Z");
    expect(sessions[0]?.eventLogSizeBytes).toBe(statSync(eventsPath).size);
    expect(countReads(eventsPath)).toBe(0);
  });

  it("falls back to cheap workspace metadata when visible activity is not persisted", async () => {
    const eventsPath = writeSession([
      { type: "assistant.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Done" } },
      { type: "assistant.message", timestamp: "2026-04-10T10:05:00.000Z", data: { content: "Ignored by list path" } },
    ]);
    const { manager } = createManager();

    const sessions = await manager.listSessionsFromDisk();

    expect(sessions[0]?.lastVisibleActivityAt).toBeUndefined();
    expect(sessions[0]?.modifiedTime).toBe("2026-04-10T09:59:00.000Z");
    expect(sessions[0]?.eventLogSizeBytes).toBe(statSync(eventsPath).size);
    expect(countReads(eventsPath)).toBe(0);
  });

  it("persists visible activity when readMessagesFromDisk parses the event log", async () => {
    const eventsPath = writeSession([
      { type: "user.message", timestamp: "2026-04-10T09:59:30.000Z", data: { content: "Hello" } },
      { type: "assistant.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Done" } },
      { type: "assistant.turn_end", timestamp: "2026-04-10T10:00:01.000Z", data: {} },
      { type: "assistant.message", timestamp: "2026-04-10T10:05:00.000Z", data: { content: "Another reply" } },
    ]);
    const { manager, sessionMetaStore } = createManager();

    const result = await manager.readMessagesFromDisk("session-1");
    expect(result.total).toBe(3);
    expect(countReads(eventsPath)).toBe(1);
    expect(sessionMetaStore.getMeta("session-1")?.lastVisibleActivityAt).toBe("2026-04-10T10:05:00.000Z");

    readFileCallMock.mockReset();
    const sessions = await manager.listSessionsFromDisk();
    expect(sessions[0]?.lastVisibleActivityAt).toBe("2026-04-10T10:05:00.000Z");
    expect(countReads(eventsPath)).toBe(0);
  });

  it("does not persist quiet interval defer activity as visible activity", async () => {
    const quietPrompt = [
      "<defer>",
      "deferId: interval_123",
      "kind: interval",
      "attentionMode: quiet",
      "</defer>",
      "",
      "User prompt:",
      "Poll deployment",
    ].join("\n");
    const eventsPath = writeSession([
      { type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: quietPrompt } },
      { type: "assistant.message", timestamp: "2026-04-10T10:00:05.000Z", data: { content: "No change yet." } },
      { type: "session.idle", timestamp: "2026-04-10T10:00:06.000Z", data: {} },
    ]);
    const { manager, sessionMetaStore } = createManager();

    const result = await manager.readMessagesFromDisk("session-1");

    expect(result.total).toBe(2);
    expect(result.lastVisibleActivityAt).toBeUndefined();
    expect(countReads(eventsPath)).toBe(1);
    expect(sessionMetaStore.getMeta("session-1")?.lastVisibleActivityAt).toBeUndefined();
  });

  it("keeps quiet interval defer entries in fast reads without advancing visible activity", async () => {
    const quietPrompt = [
      "<defer>",
      "deferId: interval_123",
      "kind: interval",
      "attentionMode: quiet",
      "</defer>",
      "",
      "User prompt:",
      "Poll deployment",
    ].join("\n");
    writeSession([
      { type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: quietPrompt } },
      { type: "assistant.message", timestamp: "2026-04-10T10:00:05.000Z", data: { content: "No change yet." } },
      { type: "session.idle", timestamp: "2026-04-10T10:00:06.000Z", data: {} },
      { type: "user.message", timestamp: "2026-04-10T10:10:00.000Z", data: { content: "Normal question" } },
      { type: "assistant.message", timestamp: "2026-04-10T10:10:05.000Z", data: { content: "Normal answer" } },
    ]);
    const { manager, sessionMetaStore } = createManager();

    const result = await manager.readMessagesFromDisk("session-1", { limit: 10 });

    expect(result.total).toBe(4);
    expect(result.messages.map((message) => message.content)).toEqual([
      quietPrompt,
      "No change yet.",
      "Normal question",
      "Normal answer",
    ]);
    expect(result.lastVisibleActivityAt).toBe("2026-04-10T10:10:05.000Z");
    expect(sessionMetaStore.getMeta("session-1")?.lastVisibleActivityAt).toBe("2026-04-10T10:10:05.000Z");
  });
});
