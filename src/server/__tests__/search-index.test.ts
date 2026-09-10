import { mkdirSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db.js";
import { createDocsIndex } from "../docs-index.js";
import { createDocsStore } from "../docs-store.js";
import { createSearchIndex } from "../search-index.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestDir, setupTestDb } from "./helpers.js";

function event(type: string, id: string, content: string, timestamp: string, data: Record<string, unknown> = {}) {
  return { type, id, timestamp, data: { content, ...data } };
}

function writeEvents(copilotHome: string, sessionId: string, events: unknown[]): void {
  const dir = join(copilotHome, "session-state", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

function fixture() {
  const db = setupTestDb();
  const copilotHome = makeTestDir("search-index");
  const taskStore = createTaskStore(db, createTestBus());
  const sessionMetaStore = createSessionMetaStore(db);
  const sessionTitles = createSessionTitlesStore(db);
  const docsStore = createDocsStore(makeTestDir("search-docs"));
  const docsIndex = createDocsIndex(db, docsStore);
  docsIndex.reindex();
  const sessions = [
    { sessionId: "11111111-1111-4111-8111-111111111111", summary: "Archived launch chat" },
    { sessionId: "22222222-2222-4222-8222-222222222222", summary: "Active chat" },
  ];
  const index = createSearchIndex(db, {
    copilotHome,
    taskStore,
    sessionMetaStore,
    sessionTitles,
    docsIndex,
    listSessions: async () => sessions,
  });
  return { db, copilotHome, docsIndex, index, sessionMetaStore, sessions, taskStore };
}

const request = {
  q: "needle",
  scope: "global" as const,
  taskId: "",
  sessionId: "",
  kind: "all" as const,
  limit: 20,
  offset: 0,
};

describe("global search index", () => {
  it("indexes literal Unicode separators without treating them as record boundaries", async () => {
    const { copilotHome, index, sessions } = fixture();
    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("assistant.message", "unicode", "needle\u2028separator\u2029tail", "2026-09-01T10:00:00.000Z"),
    ]);
    const result = await index.search(request);
    expect(result.coverage.errors).toEqual([]);
    expect(result.chats.items[0]?.matches).toMatchObject([{ sourceEventId: "unicode", snippet: "needle separator tail" }]);
    await index.shutdown();
  });

  it("stops refreshing without restarting failed sweeps", async () => {
    const { db, copilotHome, index, sessions } = fixture();
    const dir = join(copilotHome, "session-state", sessions[0]!.sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), '{"broken":');
    await index.search(request);
    await index.waitForIdle();
    const cursor = db.prepare("SELECT value FROM search_index_state WHERE key = 'sessionCursor'").get();
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await index.search({ ...request, refreshOnly: true });
      expect(result.coverage).toMatchObject({ state: "partial", reconciling: false, indexedSessions: 1 });
      expect(result.coverage.errors).toHaveLength(1);
      expect(result.coverage.errors[0]).toContain("malformed event JSON at line 1");
      expect(db.prepare("SELECT value FROM search_index_state WHERE key = 'sessionCursor'").get()).toEqual(cursor);
    }
    await index.shutdown();
  });

  it("reports partial coverage as reconciling while the last batch is still writing", async () => {
    const { db, copilotHome, index: unusedIndex, sessions, taskStore, sessionMetaStore } = fixture();
    await unusedIndex.shutdown();
    writeEvents(copilotHome, sessions[0]!.sessionId, []);
    writeFileSync(join(copilotHome, "session-state", sessions[0]!.sessionId, "events.jsonl"), '{"broken":');
    writeEvents(copilotHome, sessions[1]!.sessionId, Array.from({ length: 600 }, (_, i) =>
      event("user.message", `message-${i}`, "needle", "2026-09-01T10:00:00.000Z")));
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const reachedPause = new Promise<void>((resolve) => { reached = resolve; });
    const index = createSearchIndex(db, {
      copilotHome, taskStore, sessionMetaStore, sessionTitles: createSessionTitlesStore(db),
      listSessions: async () => sessions,
      yieldControl: async () => { reached(); await paused; },
    });
    const write = index.reconcile(request);
    await reachedPause;
    try {
      const result = await index.search({ ...request, kind: "task", refreshOnly: true });
      expect(result.coverage).toMatchObject({ state: "partial", reconciling: true });
      expect(result.coverage.errors).toHaveLength(1);
    } finally {
      release();
      await write;
      await index.waitForIdle();
    }
    const complete = await index.search({ ...request, refreshOnly: true });
    expect(complete.coverage).toMatchObject({ state: "partial", reconciling: false });
    await index.shutdown();
  });

  it("searches archived chats and tasks, groups visible messages, and preserves exact event IDs", async () => {
    const { copilotHome, index, sessionMetaStore, sessions, taskStore } = fixture();
    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("user.message", "user-1", "Find the quoted launch needle", "2026-09-01T10:00:00.000Z"),
      event("assistant.message", "assistant-1", "The launch needle is ready.", "2026-09-01T10:00:01.000Z"),
      event("tool.execution_complete", "tool-1", "needle must not be searchable", "2026-09-01T10:00:02.000Z", {
        toolCallId: "call-1",
        result: "needle tool output",
      }),
      event("user.message", "agent-1", "needle injected text", "2026-09-01T10:00:03.000Z", {
        source: "agent-task",
        parentAgentTaskId: "parent",
      }),
    ]);
    writeEvents(copilotHome, sessions[1]!.sessionId, []);
    sessionMetaStore.setArchived(sessions[0]!.sessionId, true);
    const task = taskStore.createTask("Needle deployment task");
    taskStore.updateTask(task.id, { notes: "Keep the launch needle documented", muted: true });
    taskStore.linkSession(task.id, sessions[0]!.sessionId);

    const result = await index.search(request);

    expect(result.coverage).toMatchObject({ state: "ready", indexedSessions: 2, totalSessions: 2, errors: [] });
    expect(result.chats.items).toHaveLength(1);
    expect(result.chats.items[0]).toMatchObject({
      sessionId: sessions[0]!.sessionId,
      archived: true,
      taskId: task.id,
      matchCount: 2,
    });
    expect(result.chats.items[0]!.matches.map((match) => match.sourceEventId).sort())
      .toEqual(["assistant-1", "user-1"]);
    expect(result.tasks.items).toMatchObject([{ taskId: task.id, archived: false }]);
    expect(JSON.stringify(result)).not.toContain("<mark>");
    expect(JSON.stringify(result)).not.toContain("tool output");
    expect(JSON.stringify(result)).not.toContain("injected text");
  });

  it("supports quoted phrase keywords and strict task/session scopes", async () => {
    const { copilotHome, index, sessions, taskStore } = fixture();
    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("user.message", "phrase-1", "alpha exact phrase omega", "2026-09-01T10:00:00.000Z"),
    ]);
    writeEvents(copilotHome, sessions[1]!.sessionId, [
      event("user.message", "words-1", "exact unrelated phrase", "2026-09-01T10:00:00.000Z"),
    ]);
    const task = taskStore.createTask("Phrase task");
    taskStore.linkSession(task.id, sessions[0]!.sessionId);

    const phrase = await index.search({ ...request, q: "\"exact phrase\"", kind: "chat" });
    expect(phrase.chats.items.map((hit) => hit.sessionId)).toEqual([sessions[0]!.sessionId]);

    const taskScope = await index.search({
      ...request,
      scope: "task",
      taskId: task.id,
      q: "exact",
      kind: "chat",
    });
    expect(taskScope.chats.items.map((hit) => hit.sessionId)).toEqual([sessions[0]!.sessionId]);

    const sessionScope = await index.search({
      ...request,
      scope: "session",
      sessionId: sessions[1]!.sessionId,
      q: "exact",
    });
    expect(sessionScope.chats.items.map((hit) => hit.sessionId)).toEqual([sessions[1]!.sessionId]);
    expect(sessionScope.tasks).toEqual({ items: [], total: 0 });
    expect(sessionScope.docs).toEqual({ items: [], total: 0 });
  });

  it("uses session-scope offset and limit to page every matching message", async () => {
    const { copilotHome, index, sessions } = fixture();
    writeEvents(
      copilotHome,
      sessions[0]!.sessionId,
      Array.from({ length: 12 }, (_, messageIndex) =>
        event(
          "user.message",
          `match-${messageIndex}`,
          `needle message ${messageIndex}`,
          `2026-09-01T10:00:${String(messageIndex).padStart(2, "0")}.000Z`,
        )),
    );
    writeEvents(copilotHome, sessions[1]!.sessionId, []);

    const result = await index.search({
      ...request,
      scope: "session",
      sessionId: sessions[0]!.sessionId,
      kind: "chat",
      limit: 5,
      offset: 5,
    });

    expect(result.chats.total).toBe(1);
    expect(result.chats.items[0]!.matchCount).toBe(12);
    expect(result.chats.items[0]!.matches.map((match) => match.sourceEventId))
      .toEqual(["match-5", "match-6", "match-7", "match-8", "match-9"]);
  });

  it("returns indexing coverage after one bounded batch and completes cooperatively", async () => {
    const db = setupTestDb();
    const copilotHome = makeTestDir("search-bounded-reconcile");
    const taskStore = createTaskStore(db, createTestBus());
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      summary: `Session ${index}`,
    }));
    for (const [index, session] of sessions.entries()) {
      writeEvents(copilotHome, session.sessionId, [
        event("user.message", `event-${index}`, `needle ${index}`, "2026-09-01T10:00:00.000Z"),
      ]);
    }
    const index = createSearchIndex(db, {
      copilotHome,
      taskStore,
      sessionMetaStore: createSessionMetaStore(db),
      sessionTitles: createSessionTitlesStore(db),
      listSessions: async () => sessions,
      yieldControl: async () => {},
    });

    const initial = await index.search(request);
    expect(initial.coverage.state).toBe("indexing");
    expect(initial.coverage.totalSessions).toBe(30);
    expect(initial.coverage.indexedSessions).toBeGreaterThanOrEqual(24);
    expect(initial.coverage.indexedSessions).toBeLessThan(30);

    await index.waitForIdle();
    const complete = await index.search(request);
    expect(complete.coverage).toMatchObject({
      state: "ready",
      indexedSessions: 30,
      totalSessions: 30,
    });
    await index.waitForIdle();
  });

  it("defers logs beyond the foreground byte budget and persists the scan cursor", async () => {
    const db = setupTestDb();
    const copilotHome = makeTestDir("search-byte-budget");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeEvents(copilotHome, sessionId, [
      event("user.message", "large-1", `needle ${"x".repeat(1_000)}`, "2026-09-01T10:00:00.000Z"),
    ]);
    const index = createSearchIndex(db, {
      copilotHome,
      taskStore: createTaskStore(db, createTestBus()),
      sessionMetaStore: createSessionMetaStore(db),
      sessionTitles: createSessionTitlesStore(db),
      listSessions: async () => [{ sessionId, summary: "Budgeted session" }],
      foregroundByteBudget: 1,
    });

    const initial = await index.search(request);
    expect(initial.coverage).toMatchObject({
      state: "indexing",
      indexedSessions: 0,
      totalSessions: 1,
    });

    await index.waitForIdle();
    expect((db.prepare(
      "SELECT value FROM search_index_state WHERE key = 'sessionCursor'",
    ).get() as { value?: string }).value).toBe(sessionId);
    expect((await index.search(request)).chats.total).toBe(1);
    await index.waitForIdle();
  });

  it("does not expose stale snippets while an oversized changed log is deferred", async () => {
    const db = setupTestDb();
    const copilotHome = makeTestDir("search-oversized-stale");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const sessions = [{ sessionId, summary: "Oversized changed session" }];
    writeEvents(copilotHome, sessionId, [
      event("user.message", "old-large", "old needle", "2026-09-01T10:00:00.000Z"),
    ]);
    const index = createSearchIndex(db, {
      copilotHome,
      taskStore: createTaskStore(db, createTestBus()),
      sessionMetaStore: createSessionMetaStore(db),
      sessionTitles: createSessionTitlesStore(db),
      listSessions: async () => sessions,
      foregroundByteBudget: 10_000,
    });
    await index.search(request);
    await index.waitForIdle();

    writeEvents(copilotHome, sessionId, [
      event("user.message", "new-large", `replacement ${"x".repeat(20_000)}`, "2026-09-01T10:00:00.000Z"),
    ]);
    const future = new Date(Date.now() + 2_000);
    await utimes(join(copilotHome, "session-state", sessionId, "events.jsonl"), future, future);

    const result = await index.search(request);
    expect(result.chats).toEqual({ items: [], total: 0 });
    expect(result.coverage.state).toBe("indexing");
    await index.waitForIdle();
  });

  it("removes stale hits after rewrites, truncation, and session deletion", async () => {
    const { copilotHome, index, sessions } = fixture();
    const first = event("user.message", "old-1", "stale needle", "2026-09-01T10:00:00.000Z");
    writeEvents(copilotHome, sessions[0]!.sessionId, [first]);
    writeEvents(copilotHome, sessions[1]!.sessionId, []);
    expect((await index.search(request)).chats.total).toBe(1);

    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("user.message", "new-1", "replacement text", "2026-09-01T10:00:00.000Z"),
    ]);
    const future = new Date(Date.now() + 2_000);
    await utimes(join(copilotHome, "session-state", sessions[0]!.sessionId, "events.jsonl"), future, future);
    expect((await index.search(request)).chats.total).toBe(0);

    sessions.splice(0, 1);
    expect((await index.search({ ...request, q: "replacement" })).chats.total).toBe(0);
  });

  it("quarantines every stale matched candidate beyond the foreground reconciliation batch", async () => {
    const db = setupTestDb();
    const copilotHome = makeTestDir("search-stale-candidates");
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      summary: `Session ${index}`,
    }));
    for (const [index, session] of sessions.entries()) {
      writeEvents(copilotHome, session.sessionId, [
        event("user.message", `old-${index}`, `original needle ${index}`, "2026-09-01T10:00:00.000Z"),
      ]);
    }
    const index = createSearchIndex(db, {
      copilotHome,
      taskStore: createTaskStore(db, createTestBus()),
      sessionMetaStore: createSessionMetaStore(db),
      sessionTitles: createSessionTitlesStore(db),
      listSessions: async () => sessions,
    });
    await index.search(request);
    await index.waitForIdle();

    for (const [sessionIndex, session] of sessions.entries()) {
      writeEvents(copilotHome, session.sessionId, [
        event("user.message", `new-${sessionIndex}`, `replacement ${sessionIndex}`, "2026-09-01T10:00:00.000Z"),
      ]);
      const future = new Date(Date.now() + 2_000 + sessionIndex);
      await utimes(join(copilotHome, "session-state", session.sessionId, "events.jsonl"), future, future);
    }

    const result = await index.search(request);
    expect(result.chats).toEqual({ items: [], total: 0 });
    expect(result.coverage).toMatchObject({
      state: "indexing",
      indexedSessions: 30,
      totalSessions: 30,
    });
    expect((db.prepare(
      "SELECT count(*) AS total FROM search_quarantined_sessions",
    ).get() as { total: number }).total).toBeGreaterThan(0);
    await index.waitForIdle();
  });

  it("serves docs and current task text without awaiting a paused background transcript write", async () => {
    const db = setupTestDb();
    const copilotHome = makeTestDir("search-read-write-decoupling");
    const docsStore = createDocsStore(makeTestDir("search-read-write-docs"));
    docsStore.writePage("notes/nonblocking", "# Nonblocking\n\nDocs remain searchable.");
    const docsIndex = createDocsIndex(db, docsStore);
    docsIndex.reindex();
    const taskStore = createTaskStore(db, createTestBus());
    const task = taskStore.createTask("Obsolete needle");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeEvents(
      copilotHome,
      sessionId,
      Array.from({ length: 600 }, (_, messageIndex) =>
        event("user.message", `message-${messageIndex}`, `chat ${messageIndex}`, "2026-09-01T10:00:00.000Z")),
    );
    let releaseWrite!: () => void;
    const writePaused = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const reachedPause = vi.fn();
    const index = createSearchIndex(db, {
      copilotHome,
      taskStore,
      sessionMetaStore: createSessionMetaStore(db),
      sessionTitles: createSessionTitlesStore(db),
      docsIndex,
      listSessions: async () => [{ sessionId, summary: "Large session" }],
      yieldControl: async () => {
        reachedPause();
        await writePaused;
      },
    });
    db.prepare("INSERT INTO search_tasks(taskId, title, notes) VALUES (?, ?, ?)").run(task.id, task.title, "");

    const backgroundWrite = index.reconcile(request);
    while (reachedPause.mock.calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const docsResult = await index.search({ ...request, q: "nonblocking", kind: "doc" });
    expect(docsResult.docs.items.map((item) => item.path)).toEqual(["notes/nonblocking"]);
    expect(docsResult.coverage.state).toBe("indexing");
    taskStore.updateTask(task.id, { title: "Current marker", notes: "Updated details" });
    expect((await index.search({ ...request, kind: "task" })).tasks.total).toBe(0);
    expect((await index.search({ ...request, q: "marker", kind: "task" })).tasks.items)
      .toMatchObject([{ taskId: task.id, title: "Current marker", snippet: "Current marker" }]);

    const shutdown = index.shutdown();
    releaseWrite();
    await backgroundWrite;
    await shutdown;
    expect((db.prepare("SELECT count(*) AS total FROM search_indexed_sessions").get() as { total: number }).total).toBe(0);
    expect((db.prepare("SELECT count(*) AS total FROM search_pending_messages").get() as { total: number }).total).toBe(0);
  });

  it("quarantines a valid projection and reports partial coverage when a later read fails", async () => {
    const { copilotHome, index, sessions } = fixture();
    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("user.message", "valid-1", "durable needle", "2026-09-01T10:00:00.000Z"),
    ]);
    writeEvents(copilotHome, sessions[1]!.sessionId, []);
    expect((await index.search(request)).chats.total).toBe(1);

    writeFileSync(
      join(copilotHome, "session-state", sessions[0]!.sessionId, "events.jsonl"),
      "{\"type\":",
    );
    const future = new Date(Date.now() + 2_000);
    await utimes(join(copilotHome, "session-state", sessions[0]!.sessionId, "events.jsonl"), future, future);
    const quarantined = await index.search(request);
    expect(quarantined.chats.total).toBe(0);
    expect(quarantined.coverage.state).toBe("indexing");
    await index.waitForIdle();
    const failed = await index.search(request);
    expect(failed.chats.total).toBe(0);
    expect(failed.coverage.state).toBe("partial");
    expect(failed.coverage.errors[0]).toContain(sessions[0]!.sessionId);
  });

  it("recovers a quarantined projection when its committed fingerprint is verified current", async () => {
    const { db, copilotHome, index, sessions } = fixture();
    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("user.message", "current-1", "current needle", "2026-09-01T10:00:00.000Z"),
    ]);
    writeEvents(copilotHome, sessions[1]!.sessionId, []);
    await index.search(request);
    await index.waitForIdle();
    db.prepare(`
      INSERT INTO search_quarantined_sessions(sessionId, reason, quarantinedAt)
      VALUES (?, 'promotion raced with metadata check', ?)
    `).run(sessions[0]!.sessionId, new Date().toISOString());

    await index.reconcile(request);
    await index.waitForIdle();
    expect((db.prepare("SELECT count(*) AS total FROM search_quarantined_sessions").get() as { total: number }).total)
      .toBe(0);
    expect((await index.search(request)).chats.items[0]?.matches[0]?.sourceEventId).toBe("current-1");
  });

  it("stops an in-flight catalog scan without indexing queued sessions during shutdown", async () => {
    const db = setupTestDb();
    const copilotHome = makeTestDir("search-shutdown");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeEvents(copilotHome, sessionId, [event("user.message", "queued", "needle", "2026-09-01T10:00:00.000Z")]);
    let release!: (sessions: Array<{ sessionId: string }>) => void;
    const catalog = new Promise<Array<{ sessionId: string }>>((resolve) => { release = resolve; });
    const index = createSearchIndex(db, {
      copilotHome,
      taskStore: createTaskStore(db, createTestBus()),
      sessionMetaStore: createSessionMetaStore(db),
      sessionTitles: createSessionTitlesStore(db),
      listSessions: () => catalog,
    });
    const writer = index.reconcile(request);
    const shutdown = index.shutdown();
    release([{ sessionId }]);
    await writer;
    await shutdown;
    expect((db.prepare("SELECT count(*) AS total FROM search_indexed_sessions").get() as { total: number }).total).toBe(0);
    await expect(index.search(request)).rejects.toThrow("shut down");
    await index.shutdown();
  });

  it("does not quarantine a replacement promoted while candidate stat is pending", async () => {
    const db = setupTestDb();
    const copilotHome = makeTestDir("search-promotion-race");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");
    let pause = false;
    let release!: () => void;
    let reachedPause!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { reachedPause = resolve; });
    const index = createSearchIndex(db, {
      copilotHome,
      taskStore: createTaskStore(db, createTestBus()),
      sessionMetaStore: createSessionMetaStore(db),
      sessionTitles: createSessionTitlesStore(db),
      listSessions: async () => [{ sessionId }],
      yieldControl: async () => {
        if (pause) {
          reachedPause();
          await gate;
        }
      },
    });
    const timestamp = "2026-09-01T10:00:00.000Z";
    writeEvents(copilotHome, sessionId, [event("user.message", "old", "needle", timestamp)]);
    await index.search(request);
    await index.waitForIdle();
    writeEvents(copilotHome, sessionId, Array.from({ length: 600 }, (_, messageIndex) =>
      event("user.message", `replacement-${messageIndex}`, `replacement ${messageIndex}`, timestamp)));
    pause = true;
    const writer = index.reconcile(request);
    await paused;

    const originalStat = fsPromises.stat;
    let intercepted = false;
    try {
      fsPromises.stat = (async (...args: Parameters<typeof originalStat>) => {
        const snapshot = await originalStat(...args);
        if (args[0] === eventsPath && !intercepted) {
          intercepted = true;
          release();
          await writer;
        }
        return snapshot;
      }) as typeof originalStat;
      syncBuiltinESMExports();
      await index.search(request);
    } finally {
      fsPromises.stat = originalStat;
      syncBuiltinESMExports();
      release();
      await writer;
      await index.waitForIdle();
    }

    expect(intercepted).toBe(true);
    expect(db.prepare("SELECT sessionId FROM search_quarantined_sessions WHERE sessionId = ?").get(sessionId))
      .toBeUndefined();
    const result = await index.search({ ...request, q: "replacement" });
    expect(result.chats.items[0]?.matchCount).toBe(600);
    expect(result.coverage.state).toBe("ready");
    await index.waitForIdle();
  });

  it("serializes reconciliation so stale work cannot overwrite a newer projection", async () => {
    const { copilotHome, index, sessions } = fixture();
    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("user.message", "old-1", "old needle", "2026-09-01T10:00:00.000Z"),
    ]);
    writeEvents(copilotHome, sessions[1]!.sessionId, []);
    const searches = [index.search(request), index.search(request)];
    await Promise.all(searches);
    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("user.message", "new-1", "new marker", "2026-09-01T10:00:00.000Z"),
    ]);
    const future = new Date(Date.now() + 2_000);
    await utimes(join(copilotHome, "session-state", sessions[0]!.sessionId, "events.jsonl"), future, future);
    await index.search({ ...request, q: "marker" });
    expect((await index.search(request)).chats.total).toBe(0);
  });

  it("reuses persisted rows after the SQLite database is reopened", async () => {
    const dataDir = makeTestDir("search-persistence-db");
    const copilotHome = makeTestDir("search-persistence-home");
    const sessions = [{ sessionId: "11111111-1111-4111-8111-111111111111", summary: "Persistent chat" }];
    writeEvents(copilotHome, sessions[0]!.sessionId, [
      event("user.message", "persisted-1", "persistent needle", "2026-09-01T10:00:00.000Z"),
    ]);
    const firstDb = openDatabase(dataDir);
    const first = createSearchIndex(firstDb, {
      copilotHome,
      taskStore: createTaskStore(firstDb, createTestBus()),
      sessionMetaStore: createSessionMetaStore(firstDb),
      sessionTitles: createSessionTitlesStore(firstDb),
      listSessions: async () => sessions,
    });
    await first.search(request);
    firstDb.close();

    const reopenedDb = openDatabase(dataDir);
    expect((reopenedDb.prepare(
      "SELECT count(*) AS total FROM search_chat_messages",
    ).get() as { total: number }).total).toBe(1);
    const restarted = createSearchIndex(reopenedDb, {
      copilotHome,
      taskStore: createTaskStore(reopenedDb, createTestBus()),
      sessionMetaStore: createSessionMetaStore(reopenedDb),
      sessionTitles: createSessionTitlesStore(reopenedDb),
      listSessions: async () => sessions,
    });
    expect((await restarted.search(request)).chats.total).toBe(1);
    reopenedDb.close();
  });
});
