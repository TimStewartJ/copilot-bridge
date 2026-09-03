import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalBus } from "../global-bus.js";
import { createSessionMessageOutboxRunner } from "../session-message-outbox-runner.js";
import { createSessionMessageOutboxStore } from "../session-message-outbox-store.js";
import { setupTestDb } from "./helpers.js";
import type { DatabaseSync } from "../db.js";

function makeSessionManager(options: {
  busy?: Set<string>;
  persisted?: boolean;
  archived?: Set<string>;
} = {}) {
  const busy = options.busy ?? new Set<string>();
  const archived = options.archived ?? new Set<string>();
  const started: Array<{ sessionId: string; prompt: string }> = [];
  const listSessionsFromDisk = vi.fn(async ({ includeArchived = false } = {}) =>
    ["session-1"]
      .filter((sessionId) => includeArchived || !archived.has(sessionId))
      .map((sessionId) => ({ sessionId }))
  );
  return {
    listSessionsFromDisk,
    isSessionBusy: (sessionId: string) => busy.has(sessionId),
    hasPersistedUserMessage: vi.fn(async () => options.persisted ?? false),
    startWorkAndWaitForDelivery: vi.fn(async (sessionId: string, prompt: string) => {
      started.push({ sessionId, prompt });
    }),
    markSessionAttention: vi.fn(),
    _started: started,
  };
}

let db: DatabaseSync;

beforeEach(() => {
  db = setupTestDb();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("session message outbox runner", () => {
  it("delivers a normal message to an archived parent and completes the row", async () => {
    const store = createSessionMessageOutboxStore(db);
    const item = store.enqueue({
      id: "delivery-1",
      sessionId: "session-1",
      prompt: "Deferred result",
      source: "defer_result",
      sourceId: "interval_1",
    })!;
    const sessionManager = makeSessionManager({
      archived: new Set(["session-1"]),
    });
    const runner = createSessionMessageOutboxRunner(
      store,
      sessionManager as any,
      createGlobalBus(),
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.listSessionsFromDisk).toHaveBeenCalledWith({ includeArchived: true });
    expect(sessionManager._started).toEqual([
      { sessionId: "session-1", prompt: "Deferred result" },
    ]);
    expect(store.get(item.id)?.status).toBe("completed");
    runner.shutdown();
  });

  it("waits for a busy parent and retries immediately when it becomes idle", async () => {
    const store = createSessionMessageOutboxStore(db);
    const item = store.enqueue({
      id: "delivery-1",
      sessionId: "session-1",
      prompt: "Deferred result",
      source: "defer_result",
    })!;
    const busy = new Set(["session-1"]);
    const sessionManager = makeSessionManager({ busy });
    const bus = createGlobalBus();
    const runner = createSessionMessageOutboxRunner(store, sessionManager as any, bus);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionManager._started).toEqual([]);
    expect(store.get(item.id)?.status).toBe("pending");

    busy.clear();
    bus.emit({ type: "session:idle", sessionId: "session-1" });
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager._started).toHaveLength(1);
    expect(store.get(item.id)?.status).toBe("completed");
    runner.shutdown();
  });

  it("does not cancel queued messages when the parent is archived", async () => {
    const store = createSessionMessageOutboxStore(db);
    const item = store.enqueue({
      id: "delivery-1",
      sessionId: "session-1",
      prompt: "Deferred result",
      source: "defer_result",
      availableAt: new Date(Date.now() + 60_000).toISOString(),
    })!;
    const bus = createGlobalBus();
    const runner = createSessionMessageOutboxRunner(
      store,
      makeSessionManager() as any,
      bus,
    );

    runner.start();
    bus.emit({ type: "session:archived", sessionId: "session-1", archived: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.get(item.id)?.status).toBe("pending");
    runner.shutdown();
  });

  it("suppresses restart redelivery when the exact message is already persisted", async () => {
    const store = createSessionMessageOutboxStore(db);
    const item = store.enqueue({
      id: "delivery-1",
      sessionId: "session-1",
      prompt: "Deferred result",
      source: "defer_result",
    })!;
    const sessionManager = makeSessionManager({ persisted: true });
    const runner = createSessionMessageOutboxRunner(
      store,
      sessionManager as any,
      createGlobalBus(),
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.hasPersistedUserMessage).toHaveBeenCalledWith(
      "session-1",
      "Deferred result",
    );
    expect(sessionManager._started).toEqual([]);
    expect(store.get(item.id)?.status).toBe("completed");
    runner.shutdown();
  });
});
