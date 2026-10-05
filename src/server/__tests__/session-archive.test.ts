import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archivedEventSessionIds } from "../../shared/session-archive-event.js";
import type { DatabaseSync } from "../db.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createReturnedDeferDelivery } from "../defer-result-message.js";
import { createGlobalBus, type StatusEvent } from "../global-bus.js";
import { setSessionsArchived } from "../session-archive.js";
import { createSessionMetaStore, type SessionMetaStore } from "../session-meta-store.js";
import { createSessionToolDefinitions, SESSION_ARCHIVE_MAX_SESSIONS } from "../tools/session-tools.js";
import { makeTestDir, setupTestDb } from "./helpers.js";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: DatabaseSync;
let sessionMetaStore: SessionMetaStore;
let events: StatusEvent[];
let globalBus: ReturnType<typeof createGlobalBus>;

beforeEach(() => {
  db = setupTestDb();
  sessionMetaStore = createSessionMetaStore(db);
  globalBus = createGlobalBus();
  events = [];
  globalBus.subscribe((event) => events.push(event));
});

afterEach(() => {
  db.close();
});

describe("setSessionsArchived", () => {
  it("announces a change to several sessions in one event", () => {
    const result = setSessionsArchived({ sessionMetaStore, globalBus }, [ID(1), ID(2), ID(1), ID(3)], true);

    expect(result).toEqual({ sessionIds: [ID(1), ID(2), ID(3)], errors: {} });
    expect([ID(1), ID(2), ID(3)].map((id) => sessionMetaStore.isArchived(id))).toEqual([true, true, true]);
    expect(events).toEqual([{ type: "session:archived", sessionIds: [ID(1), ID(2), ID(3)], archived: true }]);
    expect(archivedEventSessionIds(events[0]!)).toEqual([ID(1), ID(2), ID(3)]);
  });

  it("keeps the single-session event shape for one session and stays silent for none", () => {
    setSessionsArchived({ sessionMetaStore, globalBus }, [], true);
    expect(events).toEqual([]);

    setSessionsArchived({ sessionMetaStore, globalBus }, [ID(1)], false);
    expect(events).toEqual([{ type: "session:archived", sessionId: ID(1), archived: false }]);
    expect(archivedEventSessionIds(events[0]!)).toEqual([ID(1)]);
  });

  it("announces the sessions it wrote when another one fails", () => {
    const failing = {
      setArchived: vi.fn((sessionId: string, archived: boolean) => {
        if (sessionId === ID(2)) throw new Error("disk full");
        return sessionMetaStore.setArchived(sessionId, archived);
      }),
    };

    const result = setSessionsArchived({ sessionMetaStore: failing, globalBus }, [ID(1), ID(2), ID(3)], true);

    expect(result.sessionIds).toEqual([ID(1), ID(3)]);
    expect(result.errors).toEqual({ [ID(2)]: "Error: disk full" });
    expect(events).toEqual([{ type: "session:archived", sessionIds: [ID(1), ID(3)], archived: true }]);
  });
});

describe("session_archive tool", () => {
  function createHarness(options: { busy?: string[]; waiting?: string[] } = {}) {
    const copilotHome = makeTestDir("session-archive-tool");
    const deferredPromptStore = createDeferredPromptStore(db);
    const deferLoopStore = createDeferLoopStore(db);
    const tool = createSessionToolDefinitions({
      copilotHome,
      sessionMetaStore,
      globalBus,
      deferredPromptStore,
      deferLoopStore,
      sessionManager: {
        isSessionBusy: (sessionId: string) => options.busy?.includes(sessionId) ?? false,
        getPendingUserInputCount: (sessionId: string) => (options.waiting?.includes(sessionId) ? 1 : 0),
      },
    } as any).find((candidate) => candidate.name === "session_archive");
    if (!tool) throw new Error("session_archive tool not found");
    const addSession = (sessionId: string) => mkdirSync(join(copilotHome, "session-state", sessionId), { recursive: true });
    const call = (args: Record<string, unknown>) => tool.handler(
      args,
      { sessionId: ID(99), toolCallId: "tool-1", toolName: "session_archive", arguments: args },
    );
    return { call, addSession, deferredPromptStore };
  }

  it("archives many sessions with one announcement and leaves the ones in use alone", async () => {
    const { call, addSession, deferredPromptStore } = createHarness({ busy: [ID(3)], waiting: [ID(4)] });
    for (const n of [1, 2, 3, 4, 5, 6, 8]) addSession(ID(n));
    deferredPromptStore.create(ID(5), "Later", new Date(Date.now() + 60_000).toISOString());
    deferredPromptStore.enqueueDelivery(createReturnedDeferDelivery(
      { deferId: "once_1", kind: "once", parentSessionId: ID(8) },
      "Deploy finished.",
      { deliveryId: "delivery-1" },
    ));
    sessionMetaStore.setArchived(ID(6), true);
    const archivedAt = sessionMetaStore.getMeta(ID(6))?.archivedAt;

    const result = await call({ sessionIds: [ID(1), ID(2), ID(3), ID(4), ID(5), ID(6), ID(7), "not-an-id", ID(1), ID(8)] });

    expect(result).toMatchObject({
      success: true,
      archived: true,
      changed: 2,
      alreadyInState: 1,
      skipped: [
        { sessionId: ID(3), reason: "running" },
        { sessionId: ID(4), reason: "waiting on the user" },
        { sessionId: ID(5), reason: "deferred work pending" },
        { sessionId: ID(7), reason: "not found" },
        { sessionId: "not-an-id", reason: "not found" },
        { sessionId: ID(8), reason: "a result is waiting to be delivered" },
      ],
    });
    expect(events).toEqual([{ type: "session:archived", sessionIds: [ID(1), ID(2)], archived: true }]);
    expect([1, 2, 3, 4, 5, 7, 8].map((n) => sessionMetaStore.isArchived(ID(n))))
      .toEqual([true, true, false, false, false, false, false]);
    // No row for a session that does not exist, and an archived chat keeps its place in the archive.
    expect(sessionMetaStore.getMeta(ID(7))).toBeUndefined();
    expect(sessionMetaStore.getMeta(ID(6))?.archivedAt).toBe(archivedAt);
  });

  it("restores sessions whatever they are doing", async () => {
    const { call, addSession } = createHarness({ busy: [ID(1)] });
    addSession(ID(1));
    addSession(ID(2));
    sessionMetaStore.setArchived(ID(1), true);
    sessionMetaStore.setArchived(ID(2), true);

    const result = await call({ sessionIds: [ID(1), ID(2)], archived: false });

    expect(result).toMatchObject({ success: true, archived: false, changed: 2, skipped: [] });
    expect(events).toEqual([{ type: "session:archived", sessionIds: [ID(1), ID(2)], archived: false }]);
  });

  it("refuses a call without sessions or with too many", async () => {
    const { call } = createHarness();

    expect(await call({ sessionIds: "nope" })).toMatchObject({ resultType: "failure" });
    expect(await call({ sessionIds: [" "] })).toMatchObject({ resultType: "failure" });
    const tooMany = Array.from({ length: SESSION_ARCHIVE_MAX_SESSIONS + 1 }, (_, index) => ID(index));
    expect(await call({ sessionIds: tooMany })).toMatchObject({ resultType: "failure" });
    expect(events).toEqual([]);
  });
});
