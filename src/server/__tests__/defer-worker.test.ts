import { describe, expect, it, vi } from "vitest";
import {
  buildDeferWorkerPrompt,
  createDisposableDeferWorker,
  createDisposableDeferWorkerSessionId,
  isDisposableDeferWorkerSessionId,
  parseDeferWorkerResult,
} from "../defer-worker.js";
import { makeTestDir } from "./helpers.js";

describe("defer worker", () => {
  it("recognizes disposable worker session ids", () => {
    const sessionId = createDisposableDeferWorkerSessionId();
    expect(sessionId).toMatch(/^d3f3e000-/);
    expect(isDisposableDeferWorkerSessionId(sessionId)).toBe(true);
    expect(isDisposableDeferWorkerSessionId("normal-session")).toBe(false);
  });

  it("parses continue, finish, return, and safe fallback outcomes", () => {
    expect(parseDeferWorkerResult(
      '<defer-result action="continue"></defer-result>',
      "interval",
    )).toEqual({ action: "continue" });
    expect(parseDeferWorkerResult(
      '<defer-result action="finish"></defer-result>',
      "interval",
    )).toEqual({ action: "finish" });
    expect(parseDeferWorkerResult(
      '<defer-result action="return">Build failed.</defer-result>',
      "interval",
    )).toEqual({ action: "return", message: "Build failed." });
    expect(parseDeferWorkerResult("No valid tag", "interval")).toEqual({ action: "continue" });
    expect(parseDeferWorkerResult("Reminder complete", "once")).toEqual({
      action: "return",
      message: "Reminder complete",
    });
    expect(() => parseDeferWorkerResult(
      '<defer-result action="continue"></defer-result>',
      "once",
    )).toThrow("One-shot defer worker cannot continue");
  });

  it("runs with configured model options and deletes the temporary session", async () => {
    const copilotHome = makeTestDir("defer-worker");
    const buildSessionConfig = vi.fn(() => ({ mcpServers: { ado: { type: "http" } } }));
    const createSession = vi.fn(async (config: Record<string, unknown>) => ({
      sessionId: config.sessionId as string,
      sendAndWait: vi.fn(async () => ({
        data: { content: '<defer-result action="return">Validation passed.</defer-result>' },
      })),
      disconnect: vi.fn(async () => undefined),
    }));
    const deleteSession = vi.fn(async () => undefined);
    const recordSpan = vi.fn();
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
      beginLifecycle: () => () => undefined,
      reserveCapacity: async () => () => undefined,
      createSession: createSession as any,
      deleteSession,
      getCopilotHome: () => copilotHome,
      recordSpan,
    });

    const result = await worker.run({
      deferId: "interval_1",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Check validation",
      runCount: 2,
      intervalSeconds: 1200,
    });

    expect(result).toEqual({ action: "return", message: "Validation passed." });
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
    }));
    const helper = await createSession.mock.results[0]!.value;
    expect(helper.sendAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: buildDeferWorkerPrompt({
          deferId: "interval_1",
          kind: "interval",
          parentSessionId: "parent-session",
          prompt: "Check validation",
          runCount: 2,
          intervalSeconds: 1200,
        }),
      }),
      10 * 60 * 1000,
    );
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
      }),
    );
  });

  it("automatically selects the cheapest helper model when none is configured", async () => {
    const buildSessionConfig = vi.fn((_options: Record<string, unknown>) => ({}));
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
      beginLifecycle: () => () => undefined,
      reserveCapacity: async () => () => undefined,
      createSession: async (config) => ({
        sessionId: config.sessionId as string,
        sendAndWait: async () => ({
          data: { content: '<defer-result action="continue"></defer-result>' },
        }),
      }) as any,
      deleteSession: async () => undefined,
      getCopilotHome: () => makeTestDir("defer-worker-auto"),
    });

    await worker.run({
      deferId: "interval_2",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Check status",
    });

    expect(buildSessionConfig).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: "cheap-mini",
      reasoningEffortOverride: "low",
      contextTierOverride: "default",
    }));
  });

  it("falls back to an available cheap model when the configured model is stale", async () => {
    const buildSessionConfig = vi.fn((_options: Record<string, unknown>) => ({}));
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
      beginLifecycle: () => () => undefined,
      reserveCapacity: async () => () => undefined,
      createSession: async (config) => ({
        sessionId: config.sessionId as string,
        sendAndWait: async () => ({
          data: { content: '<defer-result action="continue"></defer-result>' },
        }),
      }) as any,
      deleteSession: async () => undefined,
      getCopilotHome: () => makeTestDir("defer-worker-stale-model"),
    });

    await worker.run({
      deferId: "interval_3",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Check status",
    });

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
    const createSession = vi.fn(async (config: Record<string, unknown>) => ({
      sessionId: config.sessionId as string,
      sendAndWait: async () => ({
        data: { content: '<defer-result action="finish"></defer-result>' },
      }),
    }));
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
      beginLifecycle: () => () => undefined,
      reserveCapacity: async () => () => undefined,
      createSession: createSession as any,
      deleteSession: async () => undefined,
      getCopilotHome: () => makeTestDir("defer-worker-sdk-default"),
    });

    await worker.run({
      deferId: "once_1",
      kind: "once",
      parentSessionId: "parent-session",
      prompt: "Check once",
    });

    const config = createSession.mock.calls[0]?.[0];
    expect(config).not.toHaveProperty("model");
    expect(config).not.toHaveProperty("reasoningEffort");
    expect(config).not.toHaveProperty("contextTier");
    expect(config).not.toHaveProperty("modelCapabilities");
  });
});
