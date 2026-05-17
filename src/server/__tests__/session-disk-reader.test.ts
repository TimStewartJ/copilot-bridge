import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listSessionsFromDisk,
  readMessagesFromDisk,
  type SessionDiskReaderDeps,
} from "../session-disk-reader.js";
import { makeTestDir } from "./helpers.js";

function createDeps(copilotHome: string) {
  const spans: Array<{
    name: string;
    duration: number;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const persistLastVisibleActivityAt = vi.fn();
  const deps: SessionDiskReaderDeps = {
    copilotHome,
    eventBusRegistry: {
      getBus: () => undefined,
    },
    resolveEffectiveSessionCwdFromWorkspaceYaml: () => undefined,
    recordSpan: (name, duration, sessionId, metadata) => {
      spans.push({ name, duration, sessionId, metadata });
    },
    persistLastVisibleActivityAt,
  };
  return { deps, spans, persistLastVisibleActivityAt };
}

function writeSessionFiles(copilotHome: string, sessionId: string, opts: {
  workspace?: string;
  events?: unknown[];
}) {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "workspace.yaml"),
    opts.workspace ?? "created_at: 2026-04-30T10:00:00.000Z\nsummary: Test session\n",
  );
  if (opts.events) {
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      `${opts.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  }
}

describe("listSessionsFromDisk telemetry", () => {
  it("records separate disk-list phases", async () => {
    const copilotHome = makeTestDir("session-disk-list");
    writeSessionFiles(copilotHome, "session-a", {
      workspace: "created_at: 2026-04-30T10:00:00.000Z\nsummary: Alpha\n",
      events: [
        { type: "user.message", timestamp: "2026-04-30T10:00:01.000Z", data: { content: "hello" } },
      ],
    });

    const { deps, spans } = createDeps(copilotHome);
    const sessions = await listSessionsFromDisk(deps);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "session-a",
      summary: "Alpha",
      eventLogSizeBytes: expect.any(Number),
    });
    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining([
      "session.listFromDisk.enumerate",
      "session.listFromDisk.workspace",
      "session.listFromDisk.eventsStat",
      "session.listFromDisk.sort",
      "session.listFromDisk",
    ]));
  });

  it("prefers workspace name over summary without hiding helper-looking session ids", async () => {
    const copilotHome = makeTestDir("session-disk-list-names");
    writeSessionFiles(copilotHome, "session-named", {
      workspace: [
        "created_at: 2026-04-30T10:00:00.000Z",
        "name: |-",
        "  CLI owned",
        "  name",
        "summary: Legacy summary",
      ].join("\n"),
    });
    writeSessionFiles(copilotHome, "b17e1000-0000-4000-8000-000000000001", {
      workspace: "created_at: 2026-04-30T10:00:00.000Z\nname: Helper name\n",
    });

    const { deps } = createDeps(copilotHome);
    const sessions = await listSessionsFromDisk(deps);

    expect(sessions.map((session) => session.sessionId).sort()).toEqual([
      "b17e1000-0000-4000-8000-000000000001",
      "session-named",
    ]);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "session-named", summary: "CLI owned name" }),
      expect.objectContaining({ sessionId: "b17e1000-0000-4000-8000-000000000001", summary: "Helper name" }),
    ]));
  });

  it("awaits async workspace resolution without unbounded fan-out", async () => {
    const copilotHome = makeTestDir("session-disk-list-concurrency");
    const sessionIds = Array.from({ length: 80 }, (_, index) => `session-${String(index).padStart(2, "0")}`);
    for (const sessionId of sessionIds) {
      writeSessionFiles(copilotHome, sessionId, {
        workspace: `created_at: 2026-04-30T10:00:00.000Z\nsummary: ${sessionId}\n`,
      });
    }

    const { deps } = createDeps(copilotHome);
    let activeResolvers = 0;
    let maxActiveResolvers = 0;
    deps.resolveEffectiveSessionCwdFromWorkspaceYaml = async (sessionId) => {
      activeResolvers += 1;
      maxActiveResolvers = Math.max(maxActiveResolvers, activeResolvers);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeResolvers -= 1;
      return join("workspace", sessionId);
    };

    const sessions = await listSessionsFromDisk(deps);

    expect(sessions).toHaveLength(sessionIds.length);
    expect(maxActiveResolvers).toBeLessThanOrEqual(32);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "session-00",
        context: { cwd: join("workspace", "session-00") },
      }),
    ]));
  });
});

describe("readMessagesFromDisk latest-page path", () => {
  it("uses a bounded tail transform for giant histories while preserving response shape", async () => {
    const copilotHome = makeTestDir("session-disk-reader-tail");
    const oldMessages = Array.from({ length: 120 }, (_, index) => ({
      type: "user.message",
      timestamp: `2026-04-30T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      data: { content: `old-${index}` },
    }));
    const padding = Array.from({ length: 5_000 }, (_, index) => ({
      type: "internal.trace",
      timestamp: "2026-04-30T10:00:00.000Z",
      data: { index, payload: "x".repeat(220) },
    }));
    const recentMessages = Array.from({ length: 60 }, (_, index) => ({
      type: "user.message",
      timestamp: `2026-04-30T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
      data: { content: `recent-${index}` },
    }));
    writeSessionFiles(copilotHome, "heartbeat", {
      events: [...oldMessages, ...padding, ...recentMessages],
    });

    const { deps, spans, persistLastVisibleActivityAt } = createDeps(copilotHome);
    const result = await readMessagesFromDisk(deps, "heartbeat", { limit: 50 });

    expect(result.total).toBe(180);
    expect(result.hasMore).toBe(true);
    expect(result.messages).toHaveLength(50);
    expect(result.messages[0]).toMatchObject({ id: "entry-130", content: "recent-10" });
    expect(result.messages.at(-1)).toMatchObject({ id: "entry-179", content: "recent-59" });
    expect(persistLastVisibleActivityAt).toHaveBeenCalledWith(
      "heartbeat",
      "2026-04-30T10:59:00.000Z",
    );

    const readSpan = spans.find((span) => span.name === "session.readFromDisk");
    expect(readSpan?.metadata).toMatchObject({
      mode: "tail",
      eventCount: 5_180,
      totalMessages: 180,
      messageCount: 50,
      readFullFile: false,
    });
    expect(readSpan?.metadata?.tailEventCount as number).toBeLessThan(5_180);
  });

  it("preserves full-history turn ids for tailed messages", async () => {
    const copilotHome = makeTestDir("session-disk-reader-turns");
    const oldTurns = Array.from({ length: 3 }, (_, index) => [
      { type: "assistant.turn_start", timestamp: `2026-04-30T09:0${index}:00.000Z`, data: {} },
      {
        type: "assistant.message",
        timestamp: `2026-04-30T09:0${index}:01.000Z`,
        data: { content: `old-turn-${index}` },
      },
      { type: "session.idle", timestamp: `2026-04-30T09:0${index}:02.000Z`, data: {} },
    ]).flat();
    const padding = Array.from({ length: 5_000 }, (_, index) => ({
      type: "internal.trace",
      timestamp: "2026-04-30T10:00:00.000Z",
      data: { index, payload: "x".repeat(220) },
    }));
    const recentTurns = [
      { type: "assistant.turn_start", timestamp: "2026-04-30T10:00:00.000Z", data: {} },
      {
        type: "assistant.message",
        timestamp: "2026-04-30T10:00:01.000Z",
        data: { content: "recent-turn-0" },
      },
      { type: "session.idle", timestamp: "2026-04-30T10:00:02.000Z", data: {} },
      { type: "assistant.turn_start", timestamp: "2026-04-30T10:01:00.000Z", data: {} },
      {
        type: "assistant.message",
        timestamp: "2026-04-30T10:01:01.000Z",
        data: { content: "recent-turn-1" },
      },
    ];
    writeSessionFiles(copilotHome, "turns", {
      events: [...oldTurns, ...padding, ...recentTurns],
    });

    const { deps } = createDeps(copilotHome);
    const result = await readMessagesFromDisk(deps, "turns", { limit: 2 });

    expect(result.total).toBe(5);
    expect(result.messages).toMatchObject([
      { id: "entry-3", content: "recent-turn-0", turnId: "turn-4" },
      { id: "entry-4", content: "recent-turn-1", turnId: "turn-5" },
    ]);
  });

  it("preserves fork boundaries in the latest-page tail transform", async () => {
    const copilotHome = makeTestDir("session-disk-reader-fork-boundary");
    writeSessionFiles(copilotHome, "forkable", {
      events: [
        { id: "user-1", type: "user.message", timestamp: "2026-04-30T10:00:00.000Z", data: { content: "First" } },
        { id: "turn-start-1", type: "assistant.turn_start", timestamp: "2026-04-30T10:00:01.000Z", data: {} },
        { id: "assistant-1", type: "assistant.message", timestamp: "2026-04-30T10:00:02.000Z", data: { content: "Answer one" } },
        { id: "turn-end-1", type: "assistant.turn_end", timestamp: "2026-04-30T10:00:03.000Z", data: {} },
        { id: "system-2", type: "system.message", timestamp: "2026-04-30T10:00:04.000Z", data: { content: "Repeated instructions" } },
        { id: "user-2", type: "user.message", timestamp: "2026-04-30T10:01:00.000Z", data: { content: "Second" } },
        { id: "turn-start-2", type: "assistant.turn_start", timestamp: "2026-04-30T10:01:01.000Z", data: {} },
        { id: "assistant-2", type: "assistant.message", timestamp: "2026-04-30T10:01:02.000Z", data: { content: "Answer two" } },
        { id: "turn-end-2", type: "assistant.turn_end", timestamp: "2026-04-30T10:01:03.000Z", data: {} },
      ],
    });

    const { deps } = createDeps(copilotHome);
    const result = await readMessagesFromDisk(deps, "forkable", { limit: 10 });

    const firstAssistant = result.messages.find((entry) => entry.role === "assistant" && entry.content === "Answer one");
    expect(firstAssistant?.forkBoundaryEventId).toBe("user-2");
  });

  it("falls back to a full read when events are appended during a tail read", async () => {
    const copilotHome = makeTestDir("session-disk-reader-append");
    const sessionId = "append-race";
    const initialMessages = Array.from({ length: 60 }, (_, index) => ({
      type: "user.message",
      timestamp: `2026-04-30T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
      data: { content: `initial-${index}` },
    }));
    writeSessionFiles(copilotHome, sessionId, { events: initialMessages });
    const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");
    const { deps, spans } = createDeps(copilotHome);
    let appended = false;
    deps.recordSpan = (name, duration, spanSessionId, metadata) => {
      spans.push({ name, duration, sessionId: spanSessionId, metadata });
      if (name !== "session.readFromDisk.tailRead" || appended) return;
      appended = true;
      appendFileSync(
        eventsPath,
        `${JSON.stringify({
          type: "user.message",
          timestamp: "2026-04-30T11:00:00.000Z",
          data: { content: "appended" },
        })}\n`,
      );
    };

    const result = await readMessagesFromDisk(deps, sessionId, { limit: 1 });

    expect(result.total).toBe(61);
    expect(result.messages).toMatchObject([{ id: "entry-60", content: "appended" }]);
    expect(spans.find((span) => span.name === "session.readFromDisk.tailFallback")?.metadata)
      .toMatchObject({ reason: "file-size-changed" });
    expect(spans.find((span) => span.name === "session.readFromDisk")?.metadata)
      .toMatchObject({ mode: "full", fallbackReason: "file-size-changed" });
  });

  it("returns an empty result if the event log disappears during a tail read", async () => {
    const copilotHome = makeTestDir("session-disk-reader-deleted");
    const sessionId = "deleted-race";
    writeSessionFiles(copilotHome, sessionId, {
      events: Array.from({ length: 20 }, (_, index) => ({
        type: "user.message",
        timestamp: `2026-04-30T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
        data: { content: `message-${index}` },
      })),
    });
    const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");
    const { deps, spans } = createDeps(copilotHome);
    let removed = false;
    deps.recordSpan = (name, duration, spanSessionId, metadata) => {
      spans.push({ name, duration, sessionId: spanSessionId, metadata });
      if (name !== "session.readFromDisk.tailRead" || removed) return;
      removed = true;
      rmSync(eventsPath, { force: true });
    };

    const result = await readMessagesFromDisk(deps, sessionId, { limit: 1 });

    expect(result).toEqual({ messages: [], total: 0, hasMore: false });
  });
});
