import { describe, expect, it, vi } from "vitest";
import {
  COPILOT_USAGE_PARSER_VERSION,
  scanCopilotUsageSession,
} from "../copilot-usage.js";
import { createCopilotUsageStore } from "../copilot-usage-store.js";
import { openMemoryDatabase } from "../db.js";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import {
  createCopilotUsageTestHome,
  createMockSessionManager,
  createTestApp,
  installApiRouteTestHooks,
  join,
  mkdirSync,
  request,
  writeCopilotUsageEvents,
  writeFileSync,
  writeRawCopilotUsageEvents,
} from "./api-routes-test-helpers.js";

let app: ApiRouteTestState["app"];

installApiRouteTestHooks((state) => {
  ({ app } = state);
});

const REASONING_PRICING_ASSUMPTION = "reasoning_tokens_priced_at_output_rate" as const;

// Builds a priceable SDK model whose token prices (cents-per-batch, batchSize 1M)
// convert to round USD-per-1M rates.
function sdkPriceableModel(
  id: string,
  rates: { input: number; output: number; cache: number },
  name?: string,
) {
  return {
    id,
    name: name ?? id,
    billing: {
      tokenPrices: {
        inputPrice: rates.input * 100,
        outputPrice: rates.output * 100,
        cachePrice: rates.cache * 100,
        batchSize: 1_000_000,
      },
    },
  };
}

function expectedUsageTotals(overrides: Partial<Record<
  "requests" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens" | "totalTokens",
  number
>> = {}) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function expectedCostBreakdownUsd(overrides: Partial<Record<
  "input" | "cachedInput" | "cacheWrite" | "output" | "reasoning" | "total",
  number
>> = {}) {
  return {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    ...overrides,
  };
}

function expectedCostEstimate(overrides: {
  estimatedCostUsd?: number;
  estimatedAiCredits?: number;
  costBreakdownUsd?: ReturnType<typeof expectedCostBreakdownUsd>;
  billableOutputTokens?: number;
} = {}) {
  const costBreakdownUsd = overrides.costBreakdownUsd ?? expectedCostBreakdownUsd();
  const estimatedCostUsd = overrides.estimatedCostUsd ?? costBreakdownUsd.total;
  return {
    estimatedCostUsd,
    estimatedAiCredits: overrides.estimatedAiCredits ?? estimatedCostUsd / 0.01,
    costBreakdownUsd,
    billableOutputTokens: overrides.billableOutputTokens ?? 0,
    reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
  };
}

describe("Copilot usage routes", () => {
  it("GET /api/copilot-usage returns a safe aggregated payload", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T12:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.4": {
              requests: { count: 3, cost: 99, path: "secret-request-path", details: "secret-request-details" },
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cacheReadTokens: 1_000_000,
                cacheWriteTokens: 1_000_000,
                reasoningTokens: 1_000_000,
                path: "secret-usage-path",
                details: { trace: "secret-usage-details" },
              },
              path: "secret-model-path",
              details: { raw: "secret-model-details" },
            },
            "unknown-model": {
              requests: { count: 1 },
              usage: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 5,
                cacheWriteTokens: 10,
                reasoningTokens: 25,
              },
            },
          },
        },
        path: "secret-event-path",
        details: { trace: "secret-event-details" },
      },
    ]);
    ({ app } = createTestApp({
      copilotHome,
      sessionManager: {
        ...createMockSessionManager(),
        listModels: vi.fn(async () => [sdkPriceableModel("gpt-5.4", { input: 2.5, output: 15, cache: 0.25 }, "GPT-5.4")]),
      },
    }));

    const res = await request(app).get("/api/copilot-usage");
    const pricedTotals = expectedUsageTotals({
      requests: 3,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      totalTokens: 5_000_000,
    });
    const unpricedTotals = expectedUsageTotals({
      requests: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 5,
      cacheWriteTokens: 10,
      reasoningTokens: 25,
      totalTokens: 190,
    });
    const aggregateTotals = expectedUsageTotals({
      requests: 4,
      inputTokens: 1_000_100,
      outputTokens: 1_000_050,
      cacheReadTokens: 1_000_005,
      cacheWriteTokens: 1_000_010,
      reasoningTokens: 1_000_025,
      totalTokens: 5_000_190,
    });
    const pricedCostBreakdownUsd = expectedCostBreakdownUsd({
      input: 2.5,
      cachedInput: 0.25,
      output: 15,
      reasoning: 15,
      total: 32.75,
    });
    const pricedCostEstimate = expectedCostEstimate({
      costBreakdownUsd: pricedCostBreakdownUsd,
      billableOutputTokens: 2_000_000,
    });
    const unpricedCostEstimate = expectedCostEstimate({ billableOutputTokens: 75 });
    const aggregateCostEstimate = expectedCostEstimate({
      costBreakdownUsd: pricedCostBreakdownUsd,
      billableOutputTokens: 2_000_075,
    });
    const pricedModelRow = {
      model: "gpt-5.4",
      sessions: 1,
      ...pricedTotals,
      ...pricedCostEstimate,
      pricingKey: "gpt-5.4",
      pricedAs: "gpt-5.4",
      pricingStatus: "exact",
      pricingSource: "exact",
      normalizedPricingModel: "gpt-5.4",
    };
    const unpricedModelRow = {
      model: "unknown-model",
      sessions: 1,
      ...unpricedTotals,
      ...unpricedCostEstimate,
      pricingKey: null,
      pricedAs: null,
      pricingStatus: "unpriced",
      pricingSource: "unpriced",
      normalizedPricingModel: "unknown-model",
    };
    const unpricedModelReportRow = {
      model: "unknown-model",
      sessions: 1,
      ...unpricedTotals,
      pricingKey: null,
      pricedAs: null,
      pricingStatus: "unpriced",
      pricingSource: "unpriced",
      normalizedPricingModel: "unknown-model",
    };

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      generatedAt: expect.any(String),
      index: {
        state: "idle",
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        sessionsTotal: 1,
        sessionsProcessed: 1,
        sessionsUpdated: 1,
        cachedSessions: 1,
        error: null,
      },
      totals: {
        ...aggregateTotals,
        ...aggregateCostEstimate,
        unpricedModelCount: 1,
        unpricedTokens: unpricedTotals,
      },
      coverage: {
        sessionsSeen: 1,
        sessionsWithEvents: 1,
        sessionsIncluded: 1,
        sessionsSkipped: 0,
        skippedByReason: {
          no_events: 0,
          no_shutdown: 0,
          empty_model_metrics: 0,
          parse_error: 0,
        },
        earliestIncludedAt: "2026-05-01T12:00:00.000Z",
        latestIncludedAt: "2026-05-01T12:00:00.000Z",
        earliestSkippedAt: null,
        latestSkippedAt: null,
      },
      models: [
        pricedModelRow,
        unpricedModelRow,
      ],
      sessions: [
        {
          sessionId: "usage-session",
          shutdownAt: "2026-05-01T12:00:00.000Z",
          ...aggregateTotals,
          ...aggregateCostEstimate,
          models: [
            pricedModelRow,
            unpricedModelRow,
          ],
          unpricedModels: [unpricedModelReportRow],
        },
      ],
      unpricedModels: [unpricedModelReportRow],
    });
    expect(res.body.totals).not.toHaveProperty("cost");
    expect(res.body.models[0]).not.toHaveProperty("cost");
    expect(res.body.models[0]).not.toHaveProperty("path");
    expect(res.body.models[0]).not.toHaveProperty("details");
    expect(res.body.sessions[0]).not.toHaveProperty("path");
    expect(res.body.sessions[0]).not.toHaveProperty("details");
    expect(JSON.stringify(res.body)).not.toContain(copilotHome);
    expect(JSON.stringify(res.body)).not.toContain("secret-");
  });

  it("GET /api/copilot-usage resolves observed SDK model IDs through listModels metadata", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T13:00:00.000Z",
        data: {
          modelMetrics: {
            "opaque-sdk-id": {
              requests: { count: 1 },
              usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
            },
          },
        },
      },
    ]);
    const listModels = vi.fn(async () => [
      {
        id: "opaque-sdk-id",
        name: "Claude Opus 4.7",
        billing: { note: "secret-sdk-field" },
      },
      sdkPriceableModel("claude-opus-4.7", { input: 5, output: 25, cache: 0.5 }, "Claude Opus 4.7"),
    ]);
    ({ app } = createTestApp({
      copilotHome,
      sessionManager: { ...createMockSessionManager(), listModels },
    }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(res.body.models[0]).toMatchObject({
      model: "opaque-sdk-id",
      pricingKey: "claude-opus-4.7",
      pricedAs: "claude-opus-4.7",
      pricingStatus: "sdk-name",
      pricingSource: "sdk-name",
      normalizedPricingModel: "claude-opus-4.7",
    });
    expect(res.body.models[0].estimatedCostUsd).toBeCloseTo(30);
    expect(res.body.totals.unpricedModelCount).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain("secret-sdk-field");
  });

  it("filters per-session rows for settings and task-scoped callers while keeping global totals", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "task-session", [{
      type: "session.shutdown",
      timestamp: "2026-05-01T12:00:00.000Z",
      data: {
        modelMetrics: {
          "gpt-5.4": {
            requests: { count: 1 },
            usage: { inputTokens: 10 },
          },
        },
      },
    }]);
    writeCopilotUsageEvents(copilotHome, "other-session", [{
      type: "session.shutdown",
      timestamp: "2026-05-01T13:00:00.000Z",
      data: {
        modelMetrics: {
          "gpt-5.4": {
            requests: { count: 1 },
            usage: { inputTokens: 20 },
          },
        },
      },
    }]);
    const usageDb = openMemoryDatabase();
    const copilotUsageStore = createCopilotUsageStore(usageDb);
    const sessionStateDir = join(copilotHome, "session-state");
    copilotUsageStore.upsertEntries([
      {
        sessionId: "task-session",
        parserVersion: COPILOT_USAGE_PARSER_VERSION,
        fingerprint: {
          events: { state: "missing" },
          modelState: { state: "missing" },
        },
        result: await scanCopilotUsageSession(sessionStateDir, "task-session"),
      },
      {
        sessionId: "other-session",
        parserVersion: COPILOT_USAGE_PARSER_VERSION,
        fingerprint: {
          events: { state: "missing" },
          modelState: { state: "missing" },
        },
        result: await scanCopilotUsageSession(sessionStateDir, "other-session"),
      },
    ]);
    copilotUsageStore.setLastCompletedAt(new Date().toISOString());
    const state = createTestApp({ copilotHome, copilotUsageStore });
    app = state.app;
    const task = state.ctx.taskStore.createTask("Usage task");
    state.ctx.taskStore.linkSession(task.id, "task-session");

    const settingsRes = await request(app).get("/api/copilot-usage?sessions=none");
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.totals.inputTokens).toBe(30);
    expect(settingsRes.body.sessions).toEqual([]);

    const taskRes = await request(app).get(`/api/copilot-usage?taskId=${task.id}`);
    expect(taskRes.status).toBe(200);
    expect(taskRes.body.totals.inputTokens).toBe(30);
    expect(taskRes.body.sessions.map((row: { sessionId: string }) => row.sessionId)).toEqual(["task-session"]);
    expect(taskRes.body.index).toMatchObject({
      state: "idle",
      requestedSessions: 1,
      requestedSessionsCached: 1,
    });

    const missingTaskRes = await request(app).get("/api/copilot-usage?taskId=missing");
    expect(missingTaskRes.status).toBe(404);
    expect(missingTaskRes.body).toEqual({ error: "Task not found" });
    usageDb.close();
  });

  it("GET /api/copilot-usage resolves SDK model objects through their serialized metadata", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
          timestamp: "2026-05-01T13:30:00.000Z",
          data: {
            modelMetrics: {
            "opaque-serialized-sdk-id": {
              requests: { count: 1 },
              usage: { outputTokens: 10 },
            },
          },
        },
      },
    ]);
    const listModels = vi.fn(async () => [
      {
        toJSON: () => ({
          id: "opaque-serialized-sdk-id",
          name: "Claude Opus 4.7 (Context Low)",
          billing: { note: "secret-sdk-field" },
        }),
      },
      sdkPriceableModel("claude-opus-4.7", { input: 5, output: 25, cache: 0.5 }, "Claude Opus 4.7"),
    ]);
    ({ app } = createTestApp({
      copilotHome,
      sessionManager: { ...createMockSessionManager(), listModels },
    }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(res.body.models[0]).toMatchObject({
      model: "opaque-serialized-sdk-id",
      pricingKey: "claude-opus-4.7",
      pricedAs: "claude-opus-4.7",
      pricingStatus: "sdk-name",
      pricingSource: "sdk-name",
      normalizedPricingModel: "claude-opus-4.7",
    });
    expect(res.body.models[0].estimatedCostUsd).toBeCloseTo(0.00025);
    expect(res.body.totals.unpricedModelCount).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain("secret-sdk-field");
  });

  it("GET /api/copilot-usage continues without SDK metadata when listModels fails", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T14:00:00.000Z",
        data: {
          modelMetrics: {
            "opaque-sdk-id": {
              requests: { count: 1 },
              usage: { inputTokens: 10, outputTokens: 5 },
            },
          },
        },
      },
    ]);
    const listModels = vi.fn(async () => {
      throw new Error("models unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      ({ app } = createTestApp({
        copilotHome,
        sessionManager: { ...createMockSessionManager(), listModels },
      }));

      const res = await request(app).get("/api/copilot-usage");

      expect(res.status).toBe(200);
      expect(listModels).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[copilot-usage] listModels() failed; falling back to cached model prices.",
        expect.any(Error),
      );
      expect(res.body.models[0]).toMatchObject({
        model: "opaque-sdk-id",
        pricingKey: null,
        pricedAs: null,
        pricingStatus: "unpriced",
        pricingSource: "unpriced",
        normalizedPricingModel: "opaque-sdk-id",
        estimatedCostUsd: 0,
      });
      expect(res.body.totals.unpricedModelCount).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("caches live model prices and serves them when listModels later fails", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T15:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.4": {
              requests: { count: 1 },
              usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
            },
          },
        },
      },
    ]);
    let calls = 0;
    const listModels = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return [sdkPriceableModel("gpt-5.4", { input: 2.5, output: 15, cache: 0.25 }, "GPT-5.4")];
      }
      throw new Error("models unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      ({ app } = createTestApp({
        copilotHome,
        sessionManager: { ...createMockSessionManager(), listModels },
      }));

      const first = await request(app).get("/api/copilot-usage");
      expect(first.status).toBe(200);
      expect(first.body.models[0]).toMatchObject({ model: "gpt-5.4", pricingStatus: "exact" });
      const firstCost = first.body.models[0].estimatedCostUsd;
      expect(firstCost).toBeCloseTo(17.5);

      // Force a fresh read; live metadata now fails but the cached price persists.
      const second = await request(app).get("/api/copilot-usage?refresh=1");
      expect(second.status).toBe(200);
      expect(listModels.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(second.body.models[0]).toMatchObject({ model: "gpt-5.4", pricingStatus: "exact" });
      expect(second.body.models[0].estimatedCostUsd).toBeCloseTo(firstCost);
      expect(second.body.totals.unpricedModelCount).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("prefers fresh live prices over a stale cached price for the same model id", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T16:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.4": {
              requests: { count: 1 },
              usage: { outputTokens: 1_000_000 },
            },
          },
        },
      },
    ]);
    let calls = 0;
    const listModels = vi.fn(async () => {
      calls += 1;
      const output = calls === 1 ? 15 : 30;
      return [sdkPriceableModel("gpt-5.4", { input: 2.5, output, cache: 0.25 }, "GPT-5.4")];
    });

    ({ app } = createTestApp({
      copilotHome,
      sessionManager: { ...createMockSessionManager(), listModels },
    }));

    const first = await request(app).get("/api/copilot-usage");
    expect(first.body.models[0].estimatedCostUsd).toBeCloseTo(15);

    const second = await request(app).get("/api/copilot-usage?refresh=1");
    // The newer live price (30) must win over the previously cached price (15).
    expect(second.body.models[0]).toMatchObject({ model: "gpt-5.4", pricingStatus: "exact" });
    expect(second.body.models[0].estimatedCostUsd).toBeCloseTo(30);
  });

  it("GET /api/copilot-usage supports refresh=1 cache bypass", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T12:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 1 },
              usage: { inputTokens: 5, outputTokens: 4 },
            },
          },
        },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const initial = await request(app).get("/api/copilot-usage");
    expect(initial.status).toBe(200);
    expect(initial.body.totals.totalTokens).toBe(9);

    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-02T12:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 20, outputTokens: 10 },
            },
          },
        },
      },
    ]);

    const cached = await request(app).get("/api/copilot-usage");
    expect(cached.status).toBe(200);
    expect(cached.body.totals.totalTokens).toBe(9);

    const refreshed = await request(app).get("/api/copilot-usage?refresh=1");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.totals.totalTokens).toBe(30);
    expect(refreshed.body.totals.requests).toBe(2);
  });

  it("GET /api/copilot-usage reads from injected copilotHome", async () => {
    const copilotHome = createCopilotUsageTestHome({ dotDir: true });
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-03T12:00:00.000Z",
        data: {
          modelMetrics: {
            "claude-sonnet": {
              requests: { count: 2 },
              usage: { outputTokens: 11 },
            },
          },
        },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      expect.objectContaining({
        model: "claude-sonnet",
        requests: 2,
        totalTokens: 11,
      }),
    ]);
  });

  it("GET /api/copilot-usage handles zero-includable histories cleanly", async () => {
    const copilotHome = createCopilotUsageTestHome();
    mkdirSync(join(copilotHome, "session-state", "no-events"), { recursive: true });
    writeCopilotUsageEvents(copilotHome, "no-shutdown", [
      { type: "assistant.message", timestamp: "2026-05-04T12:00:00.000Z", data: { content: "still running" } },
    ]);
    writeCopilotUsageEvents(copilotHome, "empty-metrics", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-04T13:00:00.000Z",
        data: { modelMetrics: {} },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      ...expectedUsageTotals(),
      ...expectedCostEstimate(),
      unpricedModelCount: 0,
      unpricedTokens: expectedUsageTotals(),
    });
    expect(res.body.models).toEqual([]);
    expect(res.body.unpricedModels).toEqual([]);
    expect(res.body.coverage).toEqual({
      sessionsSeen: 3,
      sessionsWithEvents: 2,
      sessionsIncluded: 0,
      sessionsSkipped: 3,
      skippedByReason: {
        no_events: 1,
        no_shutdown: 1,
        empty_model_metrics: 1,
        parse_error: 0,
      },
      earliestIncludedAt: null,
      latestIncludedAt: null,
      earliestSkippedAt: "2026-05-04T13:00:00.000Z",
      latestSkippedAt: "2026-05-04T13:00:00.000Z",
    });
  });

  it("GET /api/copilot-usage omits malformed shutdown timestamps from coverage fields", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "not-a-real-timestamp",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 7, outputTokens: 5 },
            },
          },
        },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.totals.totalTokens).toBe(12);
    expect(res.body.coverage).toEqual({
      sessionsSeen: 1,
      sessionsWithEvents: 1,
      sessionsIncluded: 1,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: null,
      latestIncludedAt: null,
      earliestSkippedAt: null,
      latestSkippedAt: null,
    });
  });

  it("GET /api/copilot-usage keeps earlier persisted shutdown summaries when a session resumes", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-05T08:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 10, outputTokens: 3 },
            },
          },
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-05-05T08:05:00.000Z",
        data: { content: "session resumed" },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-05-05T09:00:00.000Z",
        data: {
          modelMetrics: {
            o3: {
              requests: { count: 1 },
              usage: { reasoningTokens: 6 },
            },
          },
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-05-05T09:05:00.000Z",
        data: { content: "active tail" },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      ...expectedUsageTotals({
        requests: 3,
        inputTokens: 10,
        outputTokens: 3,
        reasoningTokens: 6,
        totalTokens: 19,
      }),
      ...expectedCostEstimate({ billableOutputTokens: 9 }),
      unpricedModelCount: 2,
      unpricedTokens: expectedUsageTotals({
        requests: 3,
        inputTokens: 10,
        outputTokens: 3,
        reasoningTokens: 6,
        totalTokens: 19,
      }),
    });
    expect(res.body.coverage).toEqual({
      sessionsSeen: 1,
      sessionsWithEvents: 1,
      sessionsIncluded: 1,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: "2026-05-05T08:00:00.000Z",
      latestIncludedAt: "2026-05-05T09:00:00.000Z",
      earliestSkippedAt: null,
      latestSkippedAt: null,
    });
  });

  it("GET /api/copilot-usage ignores malformed active tail lines after shutdown summaries", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeRawCopilotUsageEvents(copilotHome, "usage-session", [
      JSON.stringify({
        type: "session.shutdown",
        timestamp: "2026-05-06T08:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 10, outputTokens: 3 },
            },
          },
        },
      }),
      "{not valid json",
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      ...expectedUsageTotals({
        requests: 2,
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
      }),
      ...expectedCostEstimate({ billableOutputTokens: 3 }),
      unpricedModelCount: 1,
      unpricedTokens: expectedUsageTotals({
        requests: 2,
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
      }),
    });
    expect(res.body.coverage).toEqual({
      sessionsSeen: 1,
      sessionsWithEvents: 1,
      sessionsIncluded: 1,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: "2026-05-06T08:00:00.000Z",
      latestIncludedAt: "2026-05-06T08:00:00.000Z",
      earliestSkippedAt: null,
      latestSkippedAt: null,
    });
  });

  it("GET /api/copilot-usage returns a safe error for unreadable session-state", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeFileSync(join(copilotHome, "session-state"), "not a directory");
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Unable to read local Copilot usage history." });
    expect(JSON.stringify(res.body)).not.toContain(copilotHome);
  });
});
