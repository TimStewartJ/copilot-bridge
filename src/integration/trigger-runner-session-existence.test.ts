import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChatTrigger, makeTestDir, setupTestDb } from "../server/__tests__/helpers.js";
import { createGlobalBus } from "../server/global-bus.js";
import {
  readSessionsFromDisk,
  type SessionDiskReaderDeps,
  type SessionsFromDiskOptions,
} from "../server/session-disk-reader.js";
import { createSessionMetaStore } from "../server/session-meta-store.js";
import { createTriggerChatRunner } from "../server/triggers/chat-runner.js";
import { enforceTriggerChatRetention } from "../server/triggers/retention.js";
import { createTriggerStore } from "../server/triggers/store.js";

/**
 * The trigger runner decides whether a chat still exists by reading that chat's own folder and
 * archived flag at the moment it is about to run the chat's trigger. These tests use real folders,
 * the real store and the real disk read, and only stand in for the worker that would run the trigger.
 */
function createWorld() {
  const db = setupTestDb();
  const copilotHome = makeTestDir("trigger-runner-existence");
  const sessionMetaStore = createSessionMetaStore(db);
  const bus = createGlobalBus();
  const readerDeps: SessionDiskReaderDeps = {
    copilotHome,
    sessionMetaStore,
    eventBusRegistry: { getBus: () => undefined },
    resolveEffectiveSessionCwdFromWorkspaceYaml: () => undefined,
    recordSpan: () => {},
    persistLastVisibleActivityAt: () => {},
  };
  const ran: string[] = [];
  const sessionManager = {
    readSessionsFromDisk: (sessionIds: readonly string[], options?: SessionsFromDiskOptions) =>
      readSessionsFromDisk(readerDeps, sessionIds, options),
    isSessionBusy: () => false,
    tryAcquireDeferWorker: () => ({
      run: async (input: { parentSessionId: string; recurring: boolean }) => {
        ran.push(input.parentSessionId);
        return { action: input.recurring ? "continue" : "finish" };
      },
      release: () => {},
    }),
    markSessionAttention: () => {},
  } as any;
  const sessionDir = (sessionId: string) => join(copilotHome, "session-state", sessionId);
  const writeSession = (sessionId: string) => {
    mkdirSync(sessionDir(sessionId), { recursive: true });
    writeFileSync(join(sessionDir(sessionId), "workspace.yaml"), "created_at: 2026-05-01T10:00:00.000Z\nname: Chat\n");
    writeFileSync(join(sessionDir(sessionId), "events.jsonl"), "");
  };
  const setArchived = (sessionId: string, archived: boolean) => {
    sessionMetaStore.setArchived(sessionId, archived);
    bus.emit({ type: "session:archived", sessionId, archived });
  };
  const triggers = createTriggerStore(db);
  return {
    bus, ran, sessionManager, sessionMetaStore, writeSession, setArchived, triggers,
    removeSession: (sessionId: string) => rmSync(sessionDir(sessionId), { recursive: true, force: true }),
    /** The folder is there but its workspace.yaml cannot be read: a directory stands in its place. */
    makeUnreadable: (sessionId: string) => {
      rmSync(join(sessionDir(sessionId), "workspace.yaml"));
      mkdirSync(join(sessionDir(sessionId), "workspace.yaml"));
    },
    makeReadable: (sessionId: string) => {
      rmSync(join(sessionDir(sessionId), "workspace.yaml"), { recursive: true });
      writeSession(sessionId);
    },
    /** A one-time and a recurring worker trigger for the chat, both due now. */
    dueTriggers: (sessionId: string) => {
      const at = past();
      return {
        once: createChatTrigger(triggers, sessionId, { when: { kind: "at", at }, nextRunAt: at }),
        recurring: createChatTrigger(triggers, sessionId, { when: { kind: "every", seconds: 300 }, nextRunAt: at }),
      };
    },
    runner: () => createTriggerChatRunner(triggers, sessionManager, bus),
  };
}

const past = () => new Date(Date.now() - 1_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the trigger runner and whether a chat still exists", () => {
  it("runs the triggers of a chat that was archived and then restored", async () => {
    const world = createWorld();
    world.writeSession("chat");
    const runner = world.runner();
    runner.start();

    world.setArchived("chat", true);
    world.setArchived("chat", false);
    const { once, recurring } = world.dueTriggers("chat");
    runner.poke();
    await vi.waitFor(() => expect(world.ran).toHaveLength(2));

    expect(world.triggers.get(once.id)?.status).toBe("completed");
    expect(world.triggers.get(recurring.id)).toMatchObject({ status: "active", runCount: 1 });
    runner.shutdown();
  });

  it("cancels the triggers of a chat whose folder is gone, and of one that is archived now", async () => {
    const world = createWorld();
    world.writeSession("deleted");
    world.writeSession("archived");
    const deleted = world.dueTriggers("deleted");
    const archived = world.dueTriggers("archived");
    world.removeSession("deleted");
    // Written straight to the store: no archive event cancels these triggers up front.
    world.sessionMetaStore.setArchived("archived", true);
    const runner = world.runner();

    runner.start();
    await vi.waitFor(() => {
      for (const trigger of [deleted.once, deleted.recurring, archived.once, archived.recurring]) {
        expect(world.triggers.get(trigger.id)?.status).toBe("cancelled");
      }
    });

    expect(world.ran).toEqual([]);
    runner.shutdown();
  });

  it("leaves triggers waiting when the chat's folder cannot be read, and runs them once it can", async () => {
    const world = createWorld();
    world.writeSession("chat");
    world.makeUnreadable("chat");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { once, recurring } = world.dueTriggers("chat");
    const runner = world.runner();

    runner.start();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    expect(world.triggers.get(once.id)?.status).toBe("active");
    expect(world.triggers.get(recurring.id)).toMatchObject({ status: "active", runCount: 0 });
    expect(world.ran).toEqual([]);

    world.makeReadable("chat");
    runner.poke();
    await vi.waitFor(() => expect(world.ran).toHaveLength(2));
    expect(world.triggers.get(once.id)?.status).toBe("completed");
    runner.shutdown();
    error.mockRestore();
  });
});

describe("trigger chat retention and whether a run's chat still exists", () => {
  function createRuns(world: ReturnType<typeof createWorld>) {
    const triggerId = "daily-trigger";
    world.triggers.recordRun({ triggerId, sessionId: "latest" }, "2026-01-03T00:00:00.000Z");
    world.triggers.recordRun({ triggerId, sessionId: "older" }, "2026-01-02T00:00:00.000Z");
    world.triggers.recordRun({ triggerId, sessionId: "oldest" }, "2026-01-01T00:00:00.000Z");
    for (const sessionId of ["latest", "older", "oldest"]) world.writeSession(sessionId);
    return () => enforceTriggerChatRetention({
      triggerId,
      keepChats: 1,
      triggerStore: world.triggers,
      sessionMetaStore: world.sessionMetaStore,
      sessionManager: world.sessionManager,
      globalBus: world.bus,
    });
  }

  it("archives nothing when a candidate's folder cannot be read", async () => {
    const world = createWorld();
    const retain = createRuns(world);
    world.makeUnreadable("older");

    // The task runner prunes run history only after retention returned, so the rows stay too.
    await expect(retain()).rejects.toThrow();

    expect(world.sessionMetaStore.isArchived("older")).toBe(false);
    expect(world.sessionMetaStore.isArchived("oldest")).toBe(false);
  });

  it("treats a candidate whose folder is gone as missing, and archives the others", async () => {
    const world = createWorld();
    const retain = createRuns(world);
    world.removeSession("older");

    const result = await retain();

    expect(result).toEqual({ archivedSessionIds: ["oldest"], retainableSessionIds: [] });
    expect(world.sessionMetaStore.isArchived("oldest")).toBe(true);
  });
});