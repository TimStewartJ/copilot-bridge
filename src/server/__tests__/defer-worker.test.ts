import { describe, expect, it, vi } from "vitest";
import {
  buildDeferWorkerSystemPrompt,
  buildDeferWorkerPrompt,
  createDisposableDeferWorker,
  createDisposableDeferWorkerSessionId,
  isDisposableDeferWorkerSessionId,
  parseDeferWorkerResult,
} from "../defer-worker.js";
import { DEFER_CHECKPOINT_MAX_BYTES } from "../defer-checkpoint.js";
import { makeTestDir } from "./helpers.js";

function createEventSession(
  sessionId: string,
  content: string,
  options: { disconnect?: () => Promise<void> } = {},
) {
  let handler: ((event: unknown) => void) | undefined;
  return {
    sessionId,
    on: (nextHandler: (event: unknown) => void) => {
      handler = nextHandler;
      return () => {
        handler = undefined;
      };
    },
    send: vi.fn(async () => {
      handler?.({ type: "assistant.turn_start", data: { turnId: "1" } });
      handler?.({ type: "assistant.message", data: { content } });
      handler?.({ type: "assistant.turn_end", data: { turnId: "1" } });
    }),
    disconnect: options.disconnect ?? vi.fn(async () => undefined),
  };
}

function createWorkerWithEvents(events: unknown[], label: string) {
  return createDisposableDeferWorker({
    getSettings: () => ({
      mcpServers: {},
      deferWorker: { model: "small-model", reasoningEffort: "low", contextTier: "default" },
    }),
    listModels: async () => [{ id: "small-model", supportedReasoningEfforts: ["low"] }] as any,
    buildSessionConfig: () => ({}),
    getParentWorkingDirectory: () => undefined,
    beginLifecycle: () => () => undefined,
    reserveCapacity: async () => () => undefined,
    createSession: async (config) => {
      let handler: ((event: unknown) => void) | undefined;
      return {
        sessionId: config.sessionId as string,
        on: (nextHandler: (event: unknown) => void) => {
          handler = nextHandler;
          return () => {
            handler = undefined;
          };
        },
        send: async () => {
          for (const event of events) handler?.(event);
        },
      } as any;
    },
    deleteSession: async () => undefined,
    getCopilotHome: () => makeTestDir(label),
  });
}

const workerInput = {
  deferId: "interval_1",
  kind: "interval" as const,
  parentSessionId: "parent-session",
  prompt: "Check build",
};

function runWorkerEvents(events: unknown[], label: string) {
  return createWorkerWithEvents(events, label).run(workerInput);
}

describe("defer worker", () => {
  it("recognizes disposable worker session ids", () => {
    const sessionId = createDisposableDeferWorkerSessionId();
    expect(sessionId).toMatch(/^d3f3e000-/);
    expect(isDisposableDeferWorkerSessionId(sessionId)).toBe(true);
    expect(isDisposableDeferWorkerSessionId("normal-session")).toBe(false);
  });

  it("parses explicit outcomes and rejects malformed responses", () => {
    expect(parseDeferWorkerResult(
      '<defer-result action="continue"></defer-result>',
      "interval",
    )).toEqual({ action: "continue" });
    expect(parseDeferWorkerResult(
      '<defer-result action="notify">Build still running.</defer-result>',
      "interval",
    )).toEqual({ action: "notify", message: "Build still running." });
    expect(parseDeferWorkerResult(
      '<defer-result action="finish"></defer-result>',
      "interval",
    )).toEqual({ action: "finish" });
    expect(parseDeferWorkerResult(
      '<defer-result action="return">Build failed.</defer-result>',
      "interval",
    )).toEqual({ action: "return", message: "Build failed." });
    expect(() => parseDeferWorkerResult("No valid tag", "interval"))
      .toThrow("did not contain one valid result tag");
    expect(() => parseDeferWorkerResult("Reminder complete", "once"))
      .toThrow("did not contain one valid result tag");
    expect(() => parseDeferWorkerResult(
      '<defer-result action="continue"></defer-result>',
      "once",
    )).toThrow("One-shot defer worker cannot continue");
    expect(() => parseDeferWorkerResult(
      '<defer-result action="notify">Still running.</defer-result>',
      "once",
    )).toThrow("One-shot defer worker cannot notify");
  });

  it("keeps recurring checkpoints separate from parent messages", () => {
    expect(parseDeferWorkerResult(
      '<defer-result action="continue"><defer-checkpoint>{"status":"running","buildId":42}</defer-checkpoint></defer-result>',
      "interval",
    )).toEqual({
      action: "continue",
      checkpoint: { status: "running", buildId: 42 },
    });
    expect(parseDeferWorkerResult(
      '<defer-result action="notify"><defer-checkpoint>{"status":"succeeded"}</defer-checkpoint>\nBuild completed.</defer-result>',
      "interval",
    )).toEqual({
      action: "notify",
      message: "Build completed.",
      checkpoint: { status: "succeeded" },
    });
    expect(parseDeferWorkerResult(
      '<defer-result action="finish"><defer-checkpoint>{"status":"succeeded"}</defer-checkpoint></defer-result>',
      "interval",
    )).toEqual({
      action: "finish",
      checkpoint: { status: "succeeded" },
    });
    expect(parseDeferWorkerResult(
      '<defer-result action="return"><defer-checkpoint>{"status":"failed"}</defer-checkpoint>\nBuild failed.</defer-result>',
      "interval",
    )).toEqual({
      action: "return",
      message: "Build failed.",
      checkpoint: { status: "failed" },
    });

    const prompt = buildDeferWorkerPrompt({
      deferId: "interval_1",
      kind: "interval",
      parentSessionId: "parent-session",
      prompt: "Check the build.",
      checkpoint: { status: "succeeded", buildId: 42 },
    });
    expect(prompt).toContain("Private checkpoint from the previous occurrence:");
    expect(prompt).toContain(
      '<defer-checkpoint>{"status":"succeeded","buildId":42}</defer-checkpoint>',
    );
    expect(buildDeferWorkerSystemPrompt("interval")).toContain(
      "Use the prior checkpoint as the baseline for change detection",
    );
    expect(buildDeferWorkerSystemPrompt("interval")).toContain(
      "With finish or return, it is retained as the final snapshot",
    );
  });

  it("rejects malformed, oversized, and one-shot checkpoints", () => {
    expect(() => parseDeferWorkerResult(
      '<defer-result action="continue"><defer-checkpoint>not-json</defer-checkpoint></defer-result>',
      "interval",
    )).toThrow("must contain valid JSON");
    expect(() => parseDeferWorkerResult(
      '<defer-result action="continue"><defer-checkpoint>[]</defer-checkpoint></defer-result>',
      "interval",
    )).toThrow("must be a JSON object");
    expect(() => parseDeferWorkerResult(
      `<defer-result action="continue"><defer-checkpoint>${JSON.stringify({
        value: "x".repeat(DEFER_CHECKPOINT_MAX_BYTES),
      })}</defer-checkpoint></defer-result>`,
      "interval",
    )).toThrow(`exceeds ${DEFER_CHECKPOINT_MAX_BYTES} bytes`);
    expect(() => parseDeferWorkerResult(
      '<defer-result action="return"><defer-checkpoint>{"status":"done"}</defer-checkpoint>Done.</defer-result>',
      "once",
    )).toThrow("Only recurring defer workers");
  });

  it("accepts a valid assistant result at turn end without waiting for session idle", async () => {
    await expect(runWorkerEvents([
      { type: "assistant.turn_start", data: { turnId: "1" } },
      {
        type: "assistant.message",
        data: { content: '<defer-result action="return">Build passed.</defer-result>' },
      },
      { type: "assistant.turn_end", data: { turnId: "1" } },
    ], "defer-worker-event-result")).resolves.toMatchObject({
      action: "return",
      message: "Build passed.",
      deliveryId: expect.any(String),
    });
  });

  it("does not accept a result message that still has pending tool requests", async () => {
    await expect(runWorkerEvents([
      {
        type: "assistant.message",
        data: {
          content: '<defer-result action="return">Premature.</defer-result>',
          toolRequests: [{ toolCallId: "tool-1" }],
        },
      },
      { type: "session.error", data: { message: "Tool failed." } },
    ], "defer-worker-pending-tools")).rejects.toThrow("Tool failed.");
  });

  it("ignores an intermediate result when more tool work follows", async () => {
    await expect(runWorkerEvents([
      { type: "assistant.turn_start", data: { turnId: "1" } },
      {
        type: "assistant.message",
        data: { content: '<defer-result action="return">Premature.</defer-result>' },
      },
      { type: "tool.execution_start", data: { toolCallId: "tool-1" } },
      { type: "tool.execution_complete", data: { toolCallId: "tool-1", success: true } },
      {
        type: "assistant.message",
        data: { content: '<defer-result action="return">Final.</defer-result>' },
      },
      { type: "assistant.turn_end", data: { turnId: "1" } },
    ], "defer-worker-intermediate-result"))
      .resolves.toMatchObject({ action: "return", message: "Final." });
  });

  it("does not revive an invalidated result from the idle fallback", async () => {
    await expect(runWorkerEvents([
      { type: "assistant.turn_start", data: { turnId: "1" } },
      {
        type: "assistant.message",
        data: {
          content: '<defer-result action="return">Premature.</defer-result>',
          toolRequests: [{ toolCallId: "tool-1" }],
        },
      },
      { type: "tool.execution_start", data: { toolCallId: "tool-1" } },
      { type: "tool.execution_complete", data: { toolCallId: "tool-1", success: true } },
      { type: "session.idle", data: {} },
    ], "defer-worker-stale-idle-result"))
      .rejects.toThrow("ended without one valid result tag");
  });

  it("waits for outstanding tool completion after turn end", async () => {
    await expect(runWorkerEvents([
      { type: "assistant.turn_start", data: { turnId: "1" } },
      { type: "tool.execution_start", data: { toolCallId: "tool-1" } },
      {
        type: "assistant.message",
        data: { content: '<defer-result action="return">Done.</defer-result>' },
      },
      { type: "assistant.turn_end", data: { turnId: "1" } },
      { type: "tool.execution_complete", data: { toolCallId: "tool-1", success: true } },
    ], "defer-worker-late-tool-completion"))
      .resolves.toMatchObject({ action: "return", message: "Done." });
  });

  it("runs with configured model options and deletes the temporary session", async () => {
    const copilotHome = makeTestDir("defer-worker");
    const buildSessionConfig = vi.fn(() => ({ mcpServers: { ado: { type: "http" } } }));
    const createSession = vi.fn(async (config: Record<string, unknown>) =>
      createEventSession(
        config.sessionId as string,
        '<defer-result action="return">Validation passed.</defer-result>',
      )
    );
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
    }));
    const helper = await createSession.mock.results[0]!.value;
    expect(helper.send).toHaveBeenCalledWith(expect.objectContaining({
      prompt: buildDeferWorkerPrompt({
        deferId: "interval_1",
        kind: "interval",
        parentSessionId: "parent-session",
        prompt: "Check validation",
        runCount: 2,
        intervalSeconds: 1200,
      }),
    }));
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
      createSession: async (config) => createEventSession(
        config.sessionId as string,
        '<defer-result action="continue"></defer-result>',
      ) as any,
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
      createSession: async (config) => createEventSession(
        config.sessionId as string,
        '<defer-result action="continue"></defer-result>',
      ) as any,
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
    const createSession = vi.fn(async (config: Record<string, unknown>) =>
      createEventSession(
        config.sessionId as string,
        '<defer-result action="finish"></defer-result>',
      )
    );
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
