import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers.js";
import type { DatabaseSync } from "../db.js";
import { createDeferredPromptStore, type DeferredPromptStore } from "../deferred-prompt-store.js";
import { createInterruptedRunStore, type InterruptedRunStore } from "../interrupted-run-store.js";
import {
  BOOT_RESUME_COOLDOWN_MS,
  RESTART_RECOVERY_CONTINUE_PROMPT,
  queueBootRecoveryPrompts,
} from "../restart-resume.js";
import { SessionRunStateController } from "../session-run-state-controller.js";
import type { SessionEventBus } from "../event-bus.js";
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
    }]);

    markers.clear("session-1");
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
    }]);
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
  const deps = () => ({ deferredPromptStore: prompts, globalBus: { emit: vi.fn() } as unknown as GlobalBus });

  it("queues a continue prompt for a run cut off by a server kill and stamps the marker", () => {
    markers.markAccepted("session-1", "normal");

    const result = queueBootRecoveryPrompts(deps(), markers, now);

    expect(result).toEqual({ resumed: ["session-1"], skippedCooldown: [], skippedQuiet: [] });
    expect(pendingRecoveryPrompts("session-1")).toBe(1);
    expect(markers.list()[0]?.lastResumedAt).toBe(now.toISOString());
  });

  it("drops quiet markers without resuming them", () => {
    markers.markAccepted("session-1", "quiet");

    const result = queueBootRecoveryPrompts(deps(), markers, now);

    expect(result).toEqual({ resumed: [], skippedCooldown: [], skippedQuiet: ["session-1"] });
    expect(pendingRecoveryPrompts("session-1")).toBe(0);
    expect(markers.list()).toEqual([]);
  });

  it("does not resume again when the resumed run takes the server down inside the cooldown", () => {
    markers.markAccepted("session-1", "normal");
    queueBootRecoveryPrompts(deps(), markers, now);
    // The resumed run is accepted again, then the server is killed before it goes idle.
    markers.markAccepted("session-1", "normal");

    const secondBoot = new Date(now.getTime() + BOOT_RESUME_COOLDOWN_MS - 1);
    const result = queueBootRecoveryPrompts(deps(), markers, secondBoot);

    expect(result).toEqual({ resumed: [], skippedCooldown: ["session-1"], skippedQuiet: [] });
    expect(pendingRecoveryPrompts("session-1")).toBe(1);
    expect(markers.list()).toEqual([]);
  });

  it("resumes again once the cooldown has passed", () => {
    markers.markAccepted("session-1", "normal");
    markers.markResumed("session-1", new Date(now.getTime() - BOOT_RESUME_COOLDOWN_MS));

    const result = queueBootRecoveryPrompts(deps(), markers, now);

    expect(result.resumed).toEqual(["session-1"]);
  });

  it("does nothing on a clean boot", () => {
    expect(queueBootRecoveryPrompts(deps(), markers, now))
      .toEqual({ resumed: [], skippedCooldown: [], skippedQuiet: [] });
  });
});
