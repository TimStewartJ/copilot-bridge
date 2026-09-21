import { BRIDGE_RESTARTING_MESSAGE } from "../backend-availability.js";
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import {
  buildDeferWorkerSystemPrompt,
  buildDeferWorkerPrompt,
  createDisposableDeferWorker,
  createDisposableDeferWorkerSessionId,
  isDisposableDeferWorkerSessionId,
} from "../defer-worker.js";
import { DEFER_CHECKPOINT_MAX_BYTES } from "../defer-checkpoint.js";

import type { BridgeNativeTool } from "../bridge-native-tools.js";
import { makeTestDir } from "./helpers.js";

function getDeferResultTool(config: Record<string, unknown>): BridgeNativeTool {
  const tools = Array.isArray(config.tools) ? config.tools as BridgeNativeTool[] : [];
  const tool = tools.find((candidate) => candidate.name === "defer_result");
  if (!tool || typeof tool.handler !== "function") {
    throw new Error("defer_result tool missing from worker config");
  }
  return tool;
}

async function submitDeferResult(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  toolCallId = "defer-result-1",
): Promise<ToolResultObject> {
  const tool = getDeferResultTool(config);
  const result = await tool.handler!(args, {
    toolCallId,
    sessionId: config.sessionId as string,
  } as ToolInvocation);
  if (
    !result
    || typeof result !== "object"
    || typeof (result as { resultType?: unknown }).resultType !== "string"
    || typeof (result as { textResultForLlm?: unknown }).textResultForLlm !== "string"
  ) {
    throw new Error("defer_result returned an invalid tool result");
  }
  const typedResult = result as ToolResultObject;
  return typedResult;
}

function createNaturalSession(
  sessionId: string,
  config: Record<string, unknown>,
  resultArgs: Record<string, unknown>,
  options: {
    copilotHome?: string;
    shutdownEvent?: unknown;
    disconnect?: () => Promise<void>;
    naturalCompletion?: Promise<void>;
  } = {},
) {
  return {
    sessionId,
    sendAndWait: vi.fn(async () => {
      await submitDeferResult(config, resultArgs);
      await options.naturalCompletion;
    }),
    disconnect: options.disconnect ?? vi.fn(async () => {
      if (options.shutdownEvent && options.copilotHome) {
        const sessionDir = join(options.copilotHome, "session-state", sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
          join(sessionDir, "events.jsonl"),
          `${JSON.stringify(options.shutdownEvent)}\n`,
        );
      }
    }),
  };
}

function createWorkerWithScript(
  script: (
    config: Record<string, unknown>,
  ) => Promise<void> | void,
  label: string,
  beginLifecycle: () => () => void,
) {
  const copilotHome = makeTestDir(label);
  return createDisposableDeferWorker({
    getSettings: () => ({
      mcpServers: {},
      deferWorker: { model: "small-model", reasoningEffort: "low", contextTier: "default" },
    }),
    listModels: async () => [{ id: "small-model", supportedReasoningEfforts: ["low"] }] as any,
    buildSessionConfig: () => ({}),
    getParentWorkingDirectory: () => undefined,
    beginLifecycle,
    reserveCapacity: async () => () => undefined,
    createSession: async (config) => {
      return {
        sessionId: config.sessionId as string,
        sendAndWait: async () => script(config),
      } as any;
    },
    deleteSession: async () => undefined,
    getCopilotHome: () => copilotHome,
  });
}

/**
 * The worker completes its lifecycle only after natural completion has run
 * every cleanup step (usage scan, span, session delete, directory and store
 * cleanup, capacity release). Awaiting that signal replaces wall-clock polling
 * of background cleanup that does real filesystem and SQLite work, and keeps
 * that work from outliving the test that started it.
 */
function createLifecycleProbe() {
  let markCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    markCompleted = resolve;
  });
  const completeLifecycle = vi.fn(() => markCompleted());
  return { beginLifecycle: () => completeLifecycle, completeLifecycle, completed };
}

const workerInput = {
  deferId: "interval_1",
  kind: "interval" as const,
  parentSessionId: "parent-session",
  prompt: "Check build",
};

async function runWorkerScript(
  script: (
    config: Record<string, unknown>,
  ) => Promise<void> | void,
  label: string,
) {
  const lifecycle = createLifecycleProbe();
  try {
    return await createWorkerWithScript(script, label, lifecycle.beginLifecycle).run(workerInput);
  } finally {
    await lifecycle.completed;
  }
}

describe("defer worker", () => {
  it("recognizes disposable worker session ids", () => {
    const sessionId = createDisposableDeferWorkerSessionId();
    expect(sessionId).toMatch(/^d3f3e000-/);
    expect(isDisposableDeferWorkerSessionId(sessionId)).toBe(true);
    expect(isDisposableDeferWorkerSessionId("normal-session")).toBe(false);
  });

  it("describes native result submission and embeds prior checkpoint data as JSON", () => {
    const prompt = buildDeferWorkerPrompt({
      deferId: "interval_1",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Check the build.",
      checkpoint: { status: "succeeded", buildId: 42 },
    });
    expect(prompt).toContain('"checkpoint": {');
    expect(prompt).toContain('"status": "succeeded"');
    expect(prompt).toContain('"buildId": 42');
    expect(buildDeferWorkerSystemPrompt("interval")).toContain(
      "Use the prior checkpoint as the baseline for change detection",
    );
    expect(buildDeferWorkerSystemPrompt("interval")).toContain(
      "With finish or return, it is retained as the final snapshot",
    );
    expect(buildDeferWorkerSystemPrompt("interval")).toContain(
      "Make exactly one successful defer_result call as your final tool action",
    );
  });

  it("accepts the first structured native result before the worker naturally completes", async () => {
    let completeNaturally!: () => void;
    const naturalCompletion = new Promise<void>((resolve) => {
      completeNaturally = resolve;
    });
    const deleteSession = vi.fn(async () => undefined);
    const releaseCapacity = vi.fn();
    const recordSpan = vi.fn();
    const lifecycle = createLifecycleProbe();
    const copilotHome = makeTestDir("defer-worker-native-result");
    const worker = createDisposableDeferWorker({
      getSettings: () => ({
        mcpServers: {},
        deferWorker: { model: "small-model", reasoningEffort: "low", contextTier: "default" },
      }),
      listModels: async () => [{ id: "small-model", supportedReasoningEfforts: ["low"] }] as any,
      buildSessionConfig: () => ({}),
      getParentWorkingDirectory: () => undefined,
      beginLifecycle: lifecycle.beginLifecycle,
      reserveCapacity: async () => releaseCapacity,
      createSession: async (config) => createNaturalSession(
        config.sessionId as string,
        config,
        {
          action: "return",
          message: "Build passed.",
          checkpoint: { status: "succeeded", buildId: 42 },
        },
        { naturalCompletion },
      ) as any,
      deleteSession,
      getCopilotHome: () => copilotHome,
      recordSpan,
    });

    await expect(worker.run(workerInput)).resolves.toMatchObject({
      action: "return",
      message: "Build passed.",
      checkpoint: { status: "succeeded", buildId: 42 },
      deliveryId: expect.any(String),
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(releaseCapacity).not.toHaveBeenCalled();
    expect(recordSpan).not.toHaveBeenCalled();
    expect(lifecycle.completeLifecycle).not.toHaveBeenCalled();

    completeNaturally();
    await lifecycle.completed;
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(releaseCapacity).toHaveBeenCalledOnce();
    expect(recordSpan).toHaveBeenCalledOnce();
    expect(lifecycle.completeLifecycle).toHaveBeenCalledOnce();
  });

  it("returns validation failures to the worker so it can correct them in the same attempt", async () => {
    await expect(runWorkerScript(async (config) => {
      const invalid = await submitDeferResult(config, {
        action: "notify",
      }, "invalid-result");
      expect(invalid.resultType).toBe("failure");
      expect(invalid.textResultForLlm).toContain("message must be a non-empty string");

      const oversized = await submitDeferResult(config, {
        action: "continue",
        checkpoint: { value: "x".repeat(DEFER_CHECKPOINT_MAX_BYTES) },
      }, "oversized-result");
      expect(oversized.resultType).toBe("failure");
      expect(oversized.textResultForLlm).toContain(`exceeds ${DEFER_CHECKPOINT_MAX_BYTES} bytes`);

      const valid = await submitDeferResult(config, {
        action: "notify",
        message: "Build still running.",
        checkpoint: { status: "running" },
      }, "valid-result");
      expect(valid.resultType).toBe("success");
    }, "defer-worker-corrected-result")).resolves.toMatchObject({
      action: "notify",
      message: "Build still running.",
      checkpoint: { status: "running" },
    });
  });

  it("keeps the first valid result immutable", async () => {
    await expect(runWorkerScript(async (config) => {
      const first = await submitDeferResult(config, {
        action: "continue",
        checkpoint: { status: "first" },
      });
      expect(first.resultType).toBe("success");

      const second = await submitDeferResult(config, {
        action: "return",
        message: "Too late.",
      }, "second-result");
      expect(second.resultType).toBe("failure");
    }, "defer-worker-first-result")).resolves.toEqual({
      action: "continue",
      checkpoint: { status: "first" },
    });
  });

  it("rejects a worker that naturally completes without submitting a native result", async () => {
    await expect(runWorkerScript(() => undefined, "defer-worker-missing-result"))
      .rejects.toThrow("ended without calling defer_result");
  });

  it("aborts an in-flight check as restart-pending and still cleans up its session", async () => {
    let endTurn!: () => void;
    let turnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      turnStarted = resolve;
    });
    const abort = vi.fn(async () => endTurn());
    const deleteSession = vi.fn(async () => undefined);
    const recordSpan = vi.fn();
    const lifecycle = createLifecycleProbe();
    const copilotHome = makeTestDir("defer-worker-abort");
    const worker = createDisposableDeferWorker({
      getSettings: () => ({ mcpServers: {} }),
      listModels: async () => [],
      buildSessionConfig: () => ({}),
      getParentWorkingDirectory: () => undefined,
      beginLifecycle: lifecycle.beginLifecycle,
      reserveCapacity: async () => () => undefined,
      createSession: async (config) => ({
        sessionId: config.sessionId as string,
        sendAndWait: () => new Promise<void>((resolve) => {
          endTurn = resolve;
          turnStarted();
        }),
        abort,
      }) as any,
      deleteSession,
      getCopilotHome: () => copilotHome,
      recordSpan,
    });

    const result = worker.run(workerInput);
    await started;
    worker.abortAll();

    await expect(result).rejects.toThrow(BRIDGE_RESTARTING_MESSAGE);
    expect(abort).toHaveBeenCalledOnce();
    await lifecycle.completed;
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(lifecycle.completeLifecycle).toHaveBeenCalledOnce();
    expect(recordSpan).toHaveBeenCalledWith(
      "defer.worker",
      expect.any(Number),
      "parent-session",
      expect.objectContaining({ action: "error", error: BRIDGE_RESTARTING_MESSAGE }),
    );
  });

  it("restricts one-shot and final recurring submissions in the native schema and handler", async () => {
    const createSession = vi.fn(async (config: Record<string, unknown>) =>
      createNaturalSession(config.sessionId as string, config, { action: "finish" })
    );
    const lifecycle = createLifecycleProbe();
    const copilotHome = makeTestDir("defer-worker-final-schema");
    const worker = createDisposableDeferWorker({
      getSettings: () => ({ mcpServers: {} }),
      listModels: async () => [],
      buildSessionConfig: () => ({}),
      getParentWorkingDirectory: () => undefined,
      beginLifecycle: lifecycle.beginLifecycle,
      reserveCapacity: async () => () => undefined,
      createSession: createSession as any,
      deleteSession: async () => undefined,
      getCopilotHome: () => copilotHome,
    });

    await worker.run({
      deferId: "interval_final",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Final check",
      isFinalRun: true,
    });
    await lifecycle.completed;

    const config = createSession.mock.calls[0]![0];
    const tool = getDeferResultTool(config);
    expect((tool.parameters as any).properties.action.enum).toEqual(["finish", "return"]);
  });

  it("runs with configured model options and deletes the temporary session", async () => {
    const copilotHome = makeTestDir("defer-worker");
    const buildSessionConfig = vi.fn(() => ({
      mcpServers: { ado: { type: "http" } },
      pendingInteractionEvents: true,
      excludedTools: ["report_intent"],
    }));
    const createSession = vi.fn(async (config: Record<string, unknown>) =>
      createNaturalSession(
        config.sessionId as string,
        config,
        { action: "return", message: "Validation passed." },
        {
          copilotHome,
          shutdownEvent: {
            id: "shutdown-1",
            type: "session.shutdown",
            timestamp: "2026-09-03T20:00:00.000Z",
            data: {
              totalNanoAiu: 2_500_000_000,
              modelMetrics: {
                "small-model": {
                  requests: { count: 1 },
                  usage: {
                    inputTokens: 100,
                    outputTokens: 20,
                    cacheReadTokens: 60,
                    cacheWriteTokens: 10,
                    reasoningTokens: 5,
                  },
                  tokenDetails: { input: { tokenCount: 30 } },
                  totalNanoAiu: 2_500_000_000,
                },
              },
            },
          },
        },
      )
    );
    const deleteSession = vi.fn(async () => undefined);
    const recordSpan = vi.fn();
    const recordUsage = vi.fn();
    const lifecycle = createLifecycleProbe();
    const worker = createDisposableDeferWorker({
      getSettings: () => ({
        mcpServers: {},
        deferWorker: {
          model: "small-model",
          reasoningEffort: "low",
          contextTier: "long_context",
        },
      }),
      listModels: async () => [{
        id: "small-model",
        supportedReasoningEfforts: ["low", "high"],
      }] as any,
      buildSessionConfig,
      getParentWorkingDirectory: () => "D:\\work",
      beginLifecycle: lifecycle.beginLifecycle,
      reserveCapacity: async () => () => undefined,
      createSession: createSession as any,
      deleteSession,
      getCopilotHome: () => copilotHome,
      recordSpan,
      recordUsage,
    });

    const result = await worker.run({
      deferId: "interval_1",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Check validation",
      runCount: 2,
      intervalSeconds: 1200,
    });

    expect(result).toMatchObject({
      action: "return",
      message: "Validation passed.",
      deliveryId: expect.any(String),
    });
    expect(buildSessionConfig).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: "small-model",
      reasoningEffortOverride: "low",
      contextTierOverride: "long_context",
    }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      clientName: "Copilot Bridge Defer Worker",
      enableConfigDiscovery: false,
      enableSessionStore: false,
      mcpServers: { ado: { type: "http" } },
      // Nobody can answer a worker, so it must not be able to ask.
      pendingInteractionEvents: false,
      excludedTools: ["report_intent", "ask_user"],
    }));
    const helper = await createSession.mock.results[0]!.value;
    expect(helper.sendAndWait).toHaveBeenCalledWith(expect.objectContaining({
      prompt: buildDeferWorkerPrompt({
        deferId: "interval_1",
        kind: "interval",
        parentSessionId: "parent-session",
        prompt: "Check validation",
        runCount: 2,
        intervalSeconds: 1200,
      }),
    }), null);
    await lifecycle.completed;
    expect(deleteSession).toHaveBeenCalledWith(expect.stringMatching(/^d3f3e000-/));
    expect(recordSpan).toHaveBeenCalledWith(
      "defer.worker",
      expect.any(Number),
      "parent-session",
      expect.objectContaining({
        deferId: "interval_1",
        runCount: 2,
        action: "return",
        model: "small-model",
        naturalCompletion: "resolved",
        resultAcceptedMs: expect.any(Number),
        postResultDurationMs: expect.any(Number),
        meteredAiCredits: 2.5,
        totalTokens: 120,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 60,
        cacheWriteTokens: 10,
        usageCaptured: true,
        usageRetained: true,
      }),
    );
    expect(recordUsage).toHaveBeenCalledWith(
      expect.stringMatching(/^d3f3e000-/),
      expect.objectContaining({
        source: {
          kind: "defer_worker",
          deferId: "interval_1",
          parentSessionId: "parent-session",
          action: "return",
        },
        totals: expect.objectContaining({
          requests: 1,
          totalTokens: 120,
          meteredAiCredits: 2.5,
        }),
      }),
    );
    expect(recordUsage.mock.invocationCallOrder[0])
      .toBeLessThan(deleteSession.mock.invocationCallOrder[0]!);
  });

  it("always cleans up when usage persistence and telemetry fail", async () => {
    const copilotHome = makeTestDir("defer-worker-cleanup-after-telemetry");
    const releaseCapacity = vi.fn();
    const deleteSession = vi.fn(async (_sessionId: string) => undefined);
    const logger = { warn: vi.fn() };
    const lifecycle = createLifecycleProbe();
    const worker = createDisposableDeferWorker({
      getSettings: () => ({
        mcpServers: {},
        deferWorker: { model: "small-model", reasoningEffort: "low", contextTier: "default" },
      }),
      listModels: async () => [{ id: "small-model", supportedReasoningEfforts: ["low"] }] as any,
      buildSessionConfig: () => ({}),
      getParentWorkingDirectory: () => undefined,
      beginLifecycle: lifecycle.beginLifecycle,
      reserveCapacity: async () => releaseCapacity,
      createSession: async (config) => createNaturalSession(
        config.sessionId as string,
        config,
        { action: "finish" },
        {
          copilotHome,
          shutdownEvent: {
            type: "session.shutdown",
            timestamp: "2026-09-03T20:00:00.000Z",
            data: {
              totalNanoAiu: 500_000_000,
              modelMetrics: {
                "small-model": {
                  requests: { count: 1 },
                  usage: { inputTokens: 10, outputTokens: 5 },
                  totalNanoAiu: 500_000_000,
                },
              },
            },
          },
        },
      ) as any,
      deleteSession,
      getCopilotHome: () => copilotHome,
      recordUsage: () => {
        throw new Error("usage write failed");
      },
      recordSpan: () => {
        throw new Error("span write failed");
      },
      logger,
    });

    await expect(worker.run({
      deferId: "once_2",
      kind: "once",
      parentSessionId: "parent-session",
      prompt: "Finish",
    })).resolves.toEqual({ action: "finish" });

    await lifecycle.completed;
    expect(releaseCapacity).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
    const workerId = deleteSession.mock.calls[0]?.[0] as string;
    expect(existsSync(join(copilotHome, "session-state", workerId))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Disposable usage persistence failed"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Disposable telemetry write failed"),
    );
  });

  it("automatically selects the cheapest helper model when none is configured", async () => {
    const buildSessionConfig = vi.fn((_options: Record<string, unknown>) => ({}));
    const lifecycle = createLifecycleProbe();
    const copilotHome = makeTestDir("defer-worker-auto");
    const worker = createDisposableDeferWorker({
      getSettings: () => ({
        mcpServers: {},
        deferWorker: { reasoningEffort: "low", contextTier: "default" },
      }),
      listModels: async () => [
        { id: "large-model", billing: { multiplier: 1 } },
        { id: "cheap-mini", billing: { multiplier: 0.25 }, supportedReasoningEfforts: ["low"] },
      ] as any,
      buildSessionConfig,
      getParentWorkingDirectory: () => undefined,
      beginLifecycle: lifecycle.beginLifecycle,
      reserveCapacity: async () => () => undefined,
      createSession: async (config) => createNaturalSession(
        config.sessionId as string,
        config,
        { action: "continue" },
      ) as any,
      deleteSession: async () => undefined,
      getCopilotHome: () => copilotHome,
    });

    await worker.run({
      deferId: "interval_2",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Check status",
    });
    await lifecycle.completed;

    expect(buildSessionConfig).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: "cheap-mini",
      reasoningEffortOverride: "low",
      contextTierOverride: "default",
    }));
  });

  it("falls back to an available cheap model when the configured model is stale", async () => {
    const buildSessionConfig = vi.fn((_options: Record<string, unknown>) => ({}));
    const lifecycle = createLifecycleProbe();
    const copilotHome = makeTestDir("defer-worker-stale-model");
    const worker = createDisposableDeferWorker({
      getSettings: () => ({
        mcpServers: {},
        deferWorker: {
          model: "removed-model",
          reasoningEffort: "high",
          contextTier: "long_context",
        },
      }),
      listModels: async () => [{
        id: "cheap-mini",
        policy: { state: "enabled" },
        billing: { multiplier: 0.25 },
        supportedReasoningEfforts: ["low"],
      }] as any,
      buildSessionConfig,
      getParentWorkingDirectory: () => undefined,
      beginLifecycle: lifecycle.beginLifecycle,
      reserveCapacity: async () => () => undefined,
      createSession: async (config) => createNaturalSession(
        config.sessionId as string,
        config,
        { action: "continue" },
      ) as any,
      deleteSession: async () => undefined,
      getCopilotHome: () => copilotHome,
    });

    await worker.run({
      deferId: "interval_3",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Check status",
    });
    await lifecycle.completed;

    expect(buildSessionConfig).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: "cheap-mini",
      contextTierOverride: "long_context",
    }));
    expect(buildSessionConfig.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffortOverride");
  });

  it("admits at most two worker lifecycles at once", () => {
    const beginLifecycle = vi.fn(() => vi.fn());
    const worker = createDisposableDeferWorker({
      getSettings: () => ({ mcpServers: {} }),
      listModels: async () => [],
      buildSessionConfig: () => ({}),
      getParentWorkingDirectory: () => undefined,
      beginLifecycle,
      reserveCapacity: async () => () => undefined,
      createSession: async () => {
        throw new Error("not used");
      },
      deleteSession: async () => undefined,
      getCopilotHome: () => makeTestDir("defer-worker-capacity"),
    });

    const first = worker.tryAcquire();
    const second = worker.tryAcquire();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(worker.tryAcquire()).toBeUndefined();
    expect(beginLifecycle).toHaveBeenCalledTimes(2);

    first?.release();
    const third = worker.tryAcquire();
    expect(third).toBeDefined();
    second?.release();
    third?.release();
  });

  it("does not reintroduce a stale global model when automatic selection has no economy model", async () => {
    const createSession = vi.fn(async (config: Record<string, unknown>) =>
      createNaturalSession(
        config.sessionId as string,
        config,
        { action: "finish" },
      )
    );
    const lifecycle = createLifecycleProbe();
    const copilotHome = makeTestDir("defer-worker-sdk-default");
    const worker = createDisposableDeferWorker({
      getSettings: () => ({
        mcpServers: {},
        model: "removed-global-model",
        reasoningEffort: "high",
        contextTier: "long_context",
        deferWorker: { model: "removed-worker-model" },
      }),
      listModels: async () => [{
        id: "expensive-model",
        policy: { state: "enabled" },
        billing: { multiplier: 2 },
      }] as any,
      buildSessionConfig: () => ({
        model: "removed-global-model",
        reasoningEffort: "high",
        contextTier: "long_context",
        modelCapabilities: { contextWindow: 1_000_000 },
      }),
      getParentWorkingDirectory: () => undefined,
      beginLifecycle: lifecycle.beginLifecycle,
      reserveCapacity: async () => () => undefined,
      createSession: createSession as any,
      deleteSession: async () => undefined,
      getCopilotHome: () => copilotHome,
    });

    await worker.run({
      deferId: "once_1",
      kind: "once",
      parentSessionId: "parent-session",
      prompt: "Check once",
    });
    await lifecycle.completed;

    const config = createSession.mock.calls[0]?.[0];
    expect(config).not.toHaveProperty("model");
    expect(config).not.toHaveProperty("reasoningEffort");
    expect(config).not.toHaveProperty("contextTier");
    expect(config).not.toHaveProperty("modelCapabilities");
  });
});
