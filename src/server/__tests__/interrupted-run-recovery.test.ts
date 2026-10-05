import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBus, makeTestDir, makeTestRuntimePaths, setupTestDb } from "./helpers.js";
import { openDatabase, type DatabaseSync } from "../db.js";
import { createDeferredPromptStore, type DeferredPromptStore } from "../deferred-prompt-store.js";
import { createInterruptedRunStore, type InterruptedRunStore } from "../interrupted-run-store.js";
import {
  BOOT_RESUME_COOLDOWN_MS,
  RESTART_RECOVERY_CONTINUE_PROMPT,
  RESTART_RESUME_GAVE_UP_MESSAGE,
  cancelScheduledRestartResume,
  createNotResumedOverlay,
  queueBootRecoveryPrompts,
} from "../restart-resume.js";
import { SessionRunStateController } from "../session-run-state-controller.js";
import { SessionManager } from "../session-manager.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createEventBusRegistry, type SessionEventBus } from "../event-bus.js";
import type { GlobalBus } from "../global-bus.js";

let db: DatabaseSync;
let markers: InterruptedRunStore;
let prompts: DeferredPromptStore;

beforeEach(() => {
  db = setupTestDb();
  markers = createInterruptedRunStore(db);
  prompts = createDeferredPromptStore(db);
});

function pendingRecoveryPrompts(sessionId: string): number {
  return prompts.listForSession(sessionId)
    .filter((prompt) => prompt.status === "pending" && prompt.prompt === RESTART_RECOVERY_CONTINUE_PROMPT)
    .length;
}

describe("interrupted-run-store", () => {
  it("records, lists, and clears an accepted run", () => {
    markers.markAccepted("session-1", "normal", new Date("2026-01-01T00:00:00.000Z"));
    expect(markers.list()).toEqual([{
      sessionId: "session-1",
      attentionMode: "normal",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      lastResumedAt: null,
      retryScheduled: false,
    }]);

    expect(markers.clear("session-1")).toBe(false);
    expect(markers.list()).toEqual([]);
  });

  it("keeps the resume stamp when the resumed run is accepted again", () => {
    markers.markAccepted("session-1", "normal", new Date("2026-01-01T00:00:00.000Z"));
    markers.markResumed("session-1", new Date("2026-01-01T00:05:00.000Z"));
    markers.markAccepted("session-1", "normal", new Date("2026-01-01T00:05:01.000Z"));

    expect(markers.list()).toEqual([{
      sessionId: "session-1",
      attentionMode: "normal",
      acceptedAt: "2026-01-01T00:05:01.000Z",
      lastResumedAt: "2026-01-01T00:05:00.000Z",
      retryScheduled: false,
    }]);
  });

  it("keeps a resume that was put off across the next accepted run, and reports it when the marker is cleared", () => {
    markers.markAccepted("session-1", "normal", new Date("2026-01-01T00:00:00.000Z"));
    markers.markRetryScheduled("session-1", new Date("2026-01-01T00:10:00.000Z"));
    markers.markAccepted("session-1", "normal", new Date("2026-01-01T00:03:00.000Z"));

    expect(markers.list()[0]).toMatchObject({ lastResumedAt: "2026-01-01T00:10:00.000Z", retryScheduled: true });
    expect(markers.clear("session-1")).toBe(true);
    expect(markers.clear("session-1")).toBe(false);
  });

  it("does not report the put-off resume when an automated turn was the last one accepted", () => {
    markers.markAccepted("session-1", "normal");
    markers.markRetryScheduled("session-1", new Date("2026-01-01T00:10:00.000Z"));
    markers.markAccepted("session-1", "quiet");

    expect(markers.clear("session-1")).toBe(false);
  });

  it("a resume made at once takes the put-off mark away", () => {
    markers.markAccepted("session-1", "normal");
    markers.markRetryScheduled("session-1", new Date("2026-01-01T00:10:00.000Z"));
    markers.markResumed("session-1", new Date("2026-01-01T00:30:00.000Z"));

    expect(markers.list()[0]).toMatchObject({ lastResumedAt: "2026-01-01T00:30:00.000Z", retryScheduled: false });
  });

  it("adds the column to a database from before it existed", () => {
    const dataDir = makeTestDir("interrupted-run-migration");
    const before = openDatabase(dataDir);
    before.exec("DROP TABLE interrupted_run_markers");
    before.exec("CREATE TABLE interrupted_run_markers (sessionId TEXT PRIMARY KEY, attentionMode TEXT NOT NULL, acceptedAt TEXT NOT NULL, lastResumedAt TEXT)");
    before.prepare("INSERT INTO interrupted_run_markers(sessionId,attentionMode,acceptedAt) VALUES(?,?,?)")
      .run("old", "normal", "2026-01-01T00:00:00.000Z");
    before.close();

    const reopened = openDatabase(dataDir);
    try {
      expect(createInterruptedRunStore(reopened).list()).toEqual([{
        sessionId: "old",
        attentionMode: "normal",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        lastResumedAt: null,
        retryScheduled: false,
      }]);
    } finally {
      reopened.close();
    }
  });
});

describe("SessionRunStateController interrupted-run markers", () => {
  function createController(overrides: {
    persistAcceptedRun?: (sessionId: string, attentionMode: "normal" | "quiet") => void;
    clearAcceptedRun?: (sessionId: string) => void;
  } = {}) {
    const warn = vi.fn();
    const controller = new SessionRunStateController({
      globalBus: { emit: vi.fn() } as unknown as GlobalBus,

      cancelPendingInteractions: () => {},
      promptDeliveryAbortedMessage: "aborted",
      promptDeliveryShutdownMessage: "shutdown",
      persistTerminalOverlay: () => {},
      clearTerminalOverlay: () => {},
      persistAcceptedRun: overrides.persistAcceptedRun
        ?? ((sessionId, attentionMode) => markers.markAccepted(sessionId, attentionMode)),
      clearAcceptedRun: overrides.clearAcceptedRun ?? ((sessionId) => markers.clear(sessionId)),
      logger: { warn },
    });
    return { controller, warn };
  }
  const bus = {} as SessionEventBus;

  it("persists a marker once the prompt is accepted and clears it when the run goes idle", () => {
    const { controller } = createController();
    controller.setSessionRunState("session-1", "busy");
    const run = controller.createRunController("session-1", bus);
    expect(markers.list()).toEqual([]);

    run.markPromptAccepted();
    expect(markers.list().map((marker) => [marker.sessionId, marker.attentionMode]))
      .toEqual([["session-1", "normal"]]);

    controller.setSessionRunState("session-1", "idle");
    expect(markers.list()).toEqual([]);
  });

  it("records quiet attention so automated turns are not resumed", () => {
    const { controller } = createController();
    controller.setSessionRunState("session-1", "busy");
    controller.setSessionRunMetadata("session-1", { attentionMode: "quiet" });
    controller.createRunController("session-1", bus).markPromptAccepted();

    expect(markers.list().map((marker) => marker.attentionMode)).toEqual(["quiet"]);
  });

  it("does not persist a marker without a live run record to clear it later", () => {
    const { controller } = createController();
    controller.createRunController("session-1", bus).markPromptAccepted();

    expect(markers.list()).toEqual([]);
  });

  it("accepts the prompt and ends the run even when marker storage fails", async () => {
    const failing = () => { throw new Error("disk full"); };
    const { controller, warn } = createController({ persistAcceptedRun: failing, clearAcceptedRun: failing });
    controller.setSessionRunState("session-1", "busy");
    const run = controller.createRunController("session-1", bus);

    run.markPromptAccepted();
    await expect(run.promptDelivery).resolves.toEqual({ status: "accepted" });
    controller.setSessionRunState("session-1", "idle");

    expect(controller.hasSessionRun("session-1")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("queueBootRecoveryPrompts", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const after = (ms: number) => new Date(now.getTime() + ms);
  let announced: Array<[string, string]>;
  const deps = () => ({
    deferredPromptStore: prompts,
    globalBus: { emit: vi.fn() } as unknown as GlobalBus,
    announce: (sessionId: string, message: string) => { announced.push([sessionId, message]); },
  });
  const recoveryPrompts = (sessionId: string) => prompts.listForSession(sessionId)
    .filter((prompt) => prompt.prompt === RESTART_RECOVERY_CONTINUE_PROMPT);
  /** The server delivered the prompt, the resumed run was accepted, and then the server went down. */
  const deliverAndCutOff = (sessionId: string) => {
    for (const prompt of recoveryPrompts(sessionId)) {
      if (prompt.status === "pending") prompts.complete(prompt.id);
    }
    markers.markAccepted(sessionId, "normal");
  };

  beforeEach(() => {
    announced = [];
  });

  it("queues a continue prompt for a run cut off by a server kill and stamps the marker", () => {
    markers.markAccepted("session-1", "normal");

    const result = queueBootRecoveryPrompts(deps(), markers, now);

    expect(result).toEqual({ resumed: ["session-1"], retryScheduled: [], gaveUp: [], skippedQuiet: [] });
    expect(pendingRecoveryPrompts("session-1")).toBe(1);
    expect(markers.list()[0]).toMatchObject({ lastResumedAt: now.toISOString(), retryScheduled: false });
    expect(announced).toEqual([]);
  });

  it("drops quiet markers without resuming them", () => {
    markers.markAccepted("session-1", "quiet");

    const result = queueBootRecoveryPrompts(deps(), markers, now);

    expect(result).toEqual({ resumed: [], retryScheduled: [], gaveUp: [], skippedQuiet: ["session-1"] });
    expect(pendingRecoveryPrompts("session-1")).toBe(0);
    expect(markers.list()).toEqual([]);
  });

  it("puts the resume off to the end of the cooldown when the resumed run is cut off again, and says so in the chat", () => {
    markers.markAccepted("session-1", "normal");
    queueBootRecoveryPrompts(deps(), markers, now);
    deliverAndCutOff("session-1");

    const secondBoot = after(92_000);
    const result = queueBootRecoveryPrompts(deps(), markers, secondBoot);

    const resumeAt = after(BOOT_RESUME_COOLDOWN_MS).toISOString();
    expect(result).toEqual({ resumed: [], retryScheduled: [{ sessionId: "session-1", resumeAt }], gaveUp: [], skippedQuiet: [] });
    expect(recoveryPrompts("session-1").filter((prompt) => prompt.status === "pending").map((prompt) => prompt.runAt))
      .toEqual([resumeAt]);
    expect(prompts.listDue(secondBoot.toISOString())).toEqual([]);
    expect(markers.list()[0]).toMatchObject({ lastResumedAt: resumeAt, retryScheduled: true });
    expect(announced).toEqual([["session-1", expect.stringContaining("resume it in about 8 minutes")]]);
  });

  it("makes the put-off resume when its time has come", () => {
    markers.markAccepted("session-1", "normal");
    queueBootRecoveryPrompts(deps(), markers, now);
    deliverAndCutOff("session-1");
    queueBootRecoveryPrompts(deps(), markers, after(92_000));

    expect(prompts.listDue(after(BOOT_RESUME_COOLDOWN_MS).toISOString()).map((prompt) => prompt.sessionId))
      .toEqual(["session-1"]);
  });

  it("leaves the run for the user when it is cut off again soon after the put-off resume", () => {
    markers.markAccepted("session-1", "normal");
    queueBootRecoveryPrompts(deps(), markers, now);
    deliverAndCutOff("session-1");
    queueBootRecoveryPrompts(deps(), markers, after(92_000));
    deliverAndCutOff("session-1");
    announced = [];

    const result = queueBootRecoveryPrompts(deps(), markers, after(BOOT_RESUME_COOLDOWN_MS + 120_000));

    expect(result).toEqual({ resumed: [], retryScheduled: [], gaveUp: ["session-1"], skippedQuiet: [] });
    expect(pendingRecoveryPrompts("session-1")).toBe(0);
    expect(markers.list()).toEqual([]);
    expect(announced).toEqual([["session-1", RESTART_RESUME_GAVE_UP_MESSAGE]]);
  });

  it("keeps the put-off resume when the server goes down again before it was made", () => {
    markers.markAccepted("session-1", "normal");
    queueBootRecoveryPrompts(deps(), markers, now);
    deliverAndCutOff("session-1");
    queueBootRecoveryPrompts(deps(), markers, after(92_000));
    announced = [];
    const resumeAt = after(BOOT_RESUME_COOLDOWN_MS).toISOString();

    // Once before it was due, and once after: the prompt is still in the queue both times.
    for (const boot of [after(5 * 60_000), after(BOOT_RESUME_COOLDOWN_MS + 60_000)]) {
      const result = queueBootRecoveryPrompts(deps(), markers, boot);
      expect(result).toEqual({ resumed: [], retryScheduled: [{ sessionId: "session-1", resumeAt }], gaveUp: [], skippedQuiet: [] });
    }
    expect(pendingRecoveryPrompts("session-1")).toBe(1);
    expect(markers.list()[0]).toMatchObject({ lastResumedAt: resumeAt, retryScheduled: true });
    expect(announced).toEqual([]);
  });

  it("resumes at once again when the run is cut off long after the put-off resume", () => {
    markers.markAccepted("session-1", "normal");
    queueBootRecoveryPrompts(deps(), markers, now);
    deliverAndCutOff("session-1");
    queueBootRecoveryPrompts(deps(), markers, after(92_000));
    deliverAndCutOff("session-1");

    const later = after(3 * 60 * 60_000);
    const result = queueBootRecoveryPrompts(deps(), markers, later);

    expect(result.resumed).toEqual(["session-1"]);
    expect(markers.list()[0]).toMatchObject({ lastResumedAt: later.toISOString(), retryScheduled: false });
  });

  it("resumes again once the cooldown has passed", () => {
    markers.markAccepted("session-1", "normal");
    markers.markResumed("session-1", new Date(now.getTime() - BOOT_RESUME_COOLDOWN_MS));

    const result = queueBootRecoveryPrompts(deps(), markers, now);

    expect(result.resumed).toEqual(["session-1"]);
  });

  it("resumes and puts off without a way to announce it", () => {
    markers.markAccepted("session-1", "normal");
    markers.markResumed("session-1", now);
    const { announce: _announce, ...withoutAnnounce } = deps();

    expect(queueBootRecoveryPrompts(withoutAnnounce, markers, after(1_000)).retryScheduled).toHaveLength(1);
  });

  it("puts the resume off even when the notice cannot be shown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    markers.markAccepted("session-1", "normal");
    markers.markResumed("session-1", now);

    const result = queueBootRecoveryPrompts({
      ...deps(),
      announce: () => { throw new Error("database is locked"); },
    }, markers, after(1_000));

    expect(result.retryScheduled).toHaveLength(1);
    expect(pendingRecoveryPrompts("session-1")).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("does nothing on a clean boot", () => {
    expect(queueBootRecoveryPrompts(deps(), markers, now))
      .toEqual({ resumed: [], retryScheduled: [], gaveUp: [], skippedQuiet: [] });
  });
});

describe("SessionManager and a resume that was put off", () => {
  function createManager(onPostponedResumeSuperseded: (sessionId: string) => void) {
    const runtimePaths = makeTestRuntimePaths("postponed-resume");
    return new SessionManager({
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      sessionMetaStore: createSessionMetaStore(db),
      taskStore: { findTaskBySessionId: vi.fn().mockReturnValue(null) } as any,
      settingsStore: { getMcpServers: () => ({}), getSettings: () => ({ mcpServers: {} }) } as any,
      config: { sessionMcpServers: {} },
      clientEnv: runtimePaths.env,
      copilotHome: runtimePaths.copilotHome,
      runtimePaths,
      interruptedRunStore: markers,
      onPostponedResumeSuperseded,
    }) as any;
  }

  it("says so when a run of the chat ends while that resume is still to come", () => {
    const superseded = vi.fn();
    const manager = createManager(superseded);
    markers.markAccepted("session-1", "normal");
    markers.markRetryScheduled("session-1", new Date(Date.now() + BOOT_RESUME_COOLDOWN_MS));

    manager.setSessionRunState("session-1", "busy");
    manager.setSessionRunState("session-1", "idle");

    expect(superseded).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(markers.list()).toEqual([]);
  });

  it("says nothing when an ordinary run ends", () => {
    const superseded = vi.fn();
    const manager = createManager(superseded);
    markers.markAccepted("session-1", "normal");
    markers.markResumed("session-1");

    manager.setSessionRunState("session-1", "busy");
    manager.setSessionRunState("session-1", "idle");

    expect(superseded).not.toHaveBeenCalled();
    expect(markers.list()).toEqual([]);
  });
});
describe("cancelScheduledRestartResume", () => {
  const deps = () => ({ deferredPromptStore: prompts, globalBus: { emit: vi.fn() } as unknown as GlobalBus });

  it("withdraws the put-off resume and leaves other deferred work alone", () => {
    const later = "2026-01-01T12:10:00.000Z";
    prompts.create("session-1", RESTART_RECOVERY_CONTINUE_PROMPT, later);
    const other = prompts.create("session-1", "check the build", later);
    prompts.create("session-2", RESTART_RECOVERY_CONTINUE_PROMPT, later);

    expect(cancelScheduledRestartResume(deps(), "session-1")).toBe(1);

    expect(pendingRecoveryPrompts("session-1")).toBe(0);
    expect(prompts.get(other.id)?.status).toBe("pending");
    expect(pendingRecoveryPrompts("session-2")).toBe(1);
    expect(cancelScheduledRestartResume(deps(), "session-1")).toBe(0);
  });
});

describe("createNotResumedOverlay", () => {
  it("is an error notice the chat shows without a run", () => {
    const at = new Date("2026-01-01T12:00:00.000Z");
    expect(createNotResumedOverlay("not resumed", at)).toEqual({
      type: "error",
      runId: expect.any(String),
      timestamp: at.toISOString(),
      notice: { kind: "error", message: "not resumed", timestamp: at.toISOString() },
    });
  });
});