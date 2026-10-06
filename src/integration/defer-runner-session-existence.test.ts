import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestDir, setupTestDb } from "../server/__tests__/helpers.js";
import { createDeferLoopRunner } from "../server/defer-loop-runner.js";
import { createDeferLoopStore } from "../server/defer-loop-store.js";
import { createDeferredPromptRunner } from "../server/deferred-prompt-runner.js";
import { createDeferredPromptStore } from "../server/deferred-prompt-store.js";
import { createGlobalBus } from "../server/global-bus.js";
import { createScheduleStore } from "../server/schedule-store.js";
import { enforceScheduleSessionRetention } from "../server/schedule-session-retention.js";
import {
  readSessionsFromDisk,
  type SessionDiskReaderDeps,
  type SessionsFromDiskOptions,
} from "../server/session-disk-reader.js";
import { createSessionMetaStore } from "../server/session-meta-store.js";

/**
 * The defer runners decide whether a chat still exists by reading that chat's own folder and
 * archived flag at the moment they are about to run its work. These tests use real folders, the
 * real store and the real disk read, and only stand in for the worker that would run the check.
 */
function createWorld() {
  const db = setupTestDb();
  const copilotHome = makeTestDir("defer-runner-existence");
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
      run: async (input: { parentSessionId: string; kind: string }) => {
        ran.push(input.parentSessionId);
        return { action: input.kind === "interval" ? "continue" : "finish" };
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
  return {
    bus, ran, sessionManager, sessionMetaStore, writeSession, setArchived,
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
    schedules: createScheduleStore(db),
    prompts: createDeferredPromptStore(db),
    loops: createDeferLoopStore(db),
  };
}

const past = () => new Date(Date.now() - 1_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("defer runners and whether a chat still exists", () => {
  it("runs the deferred work of a chat that was archived and then restored", async () => {
    const world = createWorld();
    world.writeSession("chat");
    const promptRunner = createDeferredPromptRunner(world.prompts, world.sessionManager, world.bus);
    const loopRunner = createDeferLoopRunner(world.loops, world.sessionManager, world.bus);
    promptRunner.start();
    loopRunner.start();

    world.setArchived("chat", true);
    world.setArchived("chat", false);
    const prompt = world.prompts.create("chat", "Check the build", past());
    const loop = world.loops.create({ sessionId: "chat", prompt: "Poll", intervalSeconds: 300, nextRunAt: past() });
    promptRunner.poke();
    loopRunner.poke();
    await vi.waitFor(() => expect(world.ran).toHaveLength(2));

    expect(world.prompts.get(prompt.id)?.status).toBe("completed");
    expect(world.loops.get(loop.id)?.status).toBe("active");
    expect(world.loops.get(loop.id)?.runCount).toBe(1);
    promptRunner.shutdown();
    loopRunner.shutdown();
  });

  it("cancels the deferred work of a chat whose folder is gone, and of one that is archived now", async () => {
    const world = createWorld();
    world.writeSession("deleted");
    world.writeSession("archived");
    const deletedPrompt = world.prompts.create("deleted", "Check the build", past());
    const deletedLoop = world.loops.create({ sessionId: "deleted", prompt: "Poll", intervalSeconds: 300, nextRunAt: past() });
    const archivedPrompt = world.prompts.create("archived", "Check the build", past());
    world.removeSession("deleted");
    // Written straight to the store: no archive event cancels this work up front.
    world.sessionMetaStore.setArchived("archived", true);
    const promptRunner = createDeferredPromptRunner(world.prompts, world.sessionManager, world.bus);
    const loopRunner = createDeferLoopRunner(world.loops, world.sessionManager, world.bus);

    promptRunner.start();
    loopRunner.start();
    await vi.waitFor(() => {
      expect(world.prompts.get(deletedPrompt.id)?.status).toBe("cancelled");
      expect(world.loops.get(deletedLoop.id)?.status).toBe("cancelled");
      expect(world.prompts.get(archivedPrompt.id)?.status).toBe("cancelled");
    });

    expect(world.ran).toEqual([]);
    promptRunner.shutdown();
    loopRunner.shutdown();
  });
  it("leaves deferred work pending when the chat's folder cannot be read, and runs it once it can", async () => {
    const world = createWorld();
    world.writeSession("chat");
    world.makeUnreadable("chat");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prompt = world.prompts.create("chat", "Check the build", past());
    const loop = world.loops.create({ sessionId: "chat", prompt: "Poll", intervalSeconds: 300, nextRunAt: past() });
    const promptRunner = createDeferredPromptRunner(world.prompts, world.sessionManager, world.bus);
    const loopRunner = createDeferLoopRunner(world.loops, world.sessionManager, world.bus);

    promptRunner.start();
    loopRunner.start();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));

    expect(world.prompts.get(prompt.id)?.status).toBe("pending");
    expect(world.loops.get(loop.id)?.status).toBe("active");
    expect(world.ran).toEqual([]);

    world.makeReadable("chat");
    promptRunner.poke();
    loopRunner.poke();
    await vi.waitFor(() => expect(world.ran).toHaveLength(2));
    expect(world.prompts.get(prompt.id)?.status).toBe("completed");
    promptRunner.shutdown();
    loopRunner.shutdown();
    error.mockRestore();
  });
});

describe("schedule retention and whether a run's chat still exists", () => {
  function createRuns(world: ReturnType<typeof createWorld>) {
    const schedule = world.schedules.createSchedule({
      taskId: "task-1", name: "Daily", prompt: "Run", type: "cron", cron: "0 8 * * *", autoArchiveKeep: 1,
    });
    world.sessionMetaStore.recordScheduleRun(schedule.id, "latest", "2026-01-03T00:00:00.000Z");
    world.sessionMetaStore.recordScheduleRun(schedule.id, "older", "2026-01-02T00:00:00.000Z");
    world.sessionMetaStore.recordScheduleRun(schedule.id, "oldest", "2026-01-01T00:00:00.000Z");
    for (const sessionId of ["latest", "older", "oldest"]) world.writeSession(sessionId);
    const retain = () => enforceScheduleSessionRetention({
      schedule,
      sessionMetaStore: world.sessionMetaStore,
      sessionManager: world.sessionManager,
      globalBus: world.bus,
      deferredPromptStore: world.prompts,
      deferLoopStore: world.loops,
    });
    return { schedule, retain };
  }

  it("archives and reports nothing when a candidate's folder cannot be read", async () => {
    const world = createWorld();
    const { retain } = createRuns(world);
    world.makeUnreadable("older");

    // The scheduler prunes run history only after retention returned, so the rows stay too.
    await expect(retain()).rejects.toThrow();

    expect(world.sessionMetaStore.isArchived("older")).toBe(false);
    expect(world.sessionMetaStore.isArchived("oldest")).toBe(false);
  });

  it("still treats a candidate whose folder is gone as missing, and archives the others", async () => {
    const world = createWorld();
    const { retain } = createRuns(world);
    world.removeSession("older");

    const result = await retain();

    expect(result).toEqual({ archivedSessionIds: ["oldest"], skippedSessionIds: ["older"], retainableSessionIds: [] });
    expect(world.sessionMetaStore.isArchived("oldest")).toBe(true);
  });
});
