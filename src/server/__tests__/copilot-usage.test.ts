import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CopilotUsageReadError,
  createCopilotUsageReader,
  readCopilotUsageSummary,
  type CopilotUsageSummary,
  type CopilotUsageTotals,
  type ReadCopilotUsageSummaryOptions,
} from "../copilot-usage.js";
import { makeTestDir } from "./helpers.js";

const REASONING_PRICING_ASSUMPTION = "reasoning_tokens_priced_at_output_rate" as const;

function createCopilotHome(): string {
  return makeTestDir("copilot-usage");
}

function createSession(copilotHome: string, sessionId: string): string {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function writeEvents(copilotHome: string, sessionId: string, events: unknown[]): void {
  const sessionDir = createSession(copilotHome, sessionId);
  writeFileSync(
    join(sessionDir, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

function writeRawEvents(copilotHome: string, sessionId: string, lines: string[]): void {
  const sessionDir = createSession(copilotHome, sessionId);
  writeFileSync(join(sessionDir, "events.jsonl"), `${lines.join("\n")}\n`);
}

function zeroTotals(): CopilotUsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function summaryTotals(totals: CopilotUsageTotals): CopilotUsageSummary["totals"] {
  return {
    ...totals,
    estimatedCostUsd: 0,
    estimatedAiCredits: 0,
    costBreakdownUsd: {
      input: 0,
      cachedInput: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    },
    billableOutputTokens: totals.outputTokens + totals.reasoningTokens,
    reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
    unpricedModelCount: 0,
    unpricedTokens: zeroTotals(),
  };
}

function emptySummary(generatedAt = "2026-05-02T00:00:00.000Z"): CopilotUsageSummary {
  return {
    generatedAt,
    totals: summaryTotals(zeroTotals()),
    coverage: {
      sessionsSeen: 0,
      sessionsWithEvents: 0,
      sessionsIncluded: 0,
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
    },
    models: [],
    sessions: [],
    unpricedModels: [],
  };
}

describe("readCopilotUsageSummary", () => {
  it("aggregates included sessions, defaults missing metrics to zero, and sorts models by total tokens", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-02T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
            },
            "claude-sonnet": {
              requests: { count: 1 },
              usage: { outputTokens: 7, cacheWriteTokens: 2, reasoningTokens: 1 },
            },
          },
        },
      },
    ]);
    writeEvents(copilotHome, "session-2", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-03T11:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 4 },
              usage: { inputTokens: 8 },
            },
            "gemini-2.5": {
              requests: {},
              usage: {},
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({
      copilotHome,
      now: () => Date.parse("2026-01-04T00:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      generatedAt: "2026-01-04T00:00:00.000Z",
      totals: {
        requests: 7,
        inputTokens: 18,
        outputTokens: 12,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
        totalTokens: 36,
      },
      coverage: {
        sessionsSeen: 2,
        sessionsWithEvents: 2,
        sessionsIncluded: 2,
        sessionsSkipped: 0,
        skippedByReason: {
          no_events: 0,
          no_shutdown: 0,
          empty_model_metrics: 0,
          parse_error: 0,
        },
        earliestIncludedAt: "2026-01-02T10:00:00.000Z",
        latestIncludedAt: "2026-01-03T11:00:00.000Z",
        earliestSkippedAt: null,
        latestSkippedAt: null,
      },
      models: [
        {
          model: "gpt-4o",
          sessions: 2,
          requests: 6,
          inputTokens: 18,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 26,
        },
        {
          model: "claude-sonnet",
          sessions: 1,
          requests: 1,
          inputTokens: 0,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 2,
          reasoningTokens: 1,
          totalTokens: 10,
        },
        {
          model: "gemini-2.5",
          sessions: 1,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
      ],
      sessions: [
        {
          sessionId: "session-2",
          shutdownAt: "2026-01-03T11:00:00.000Z",
          requests: 4,
          inputTokens: 8,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 8,
          models: [
            {
              model: "gpt-4o",
              sessions: 1,
              requests: 4,
              inputTokens: 8,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 8,
            },
            {
              model: "gemini-2.5",
              sessions: 1,
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 0,
            },
          ],
        },
        {
          sessionId: "session-1",
          shutdownAt: "2026-01-02T10:00:00.000Z",
          requests: 3,
          inputTokens: 10,
          outputTokens: 12,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          reasoningTokens: 1,
          totalTokens: 28,
          models: [
            {
              model: "gpt-4o",
              sessions: 1,
              requests: 2,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 3,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 18,
            },
            {
              model: "claude-sonnet",
              sessions: 1,
              requests: 1,
              inputTokens: 0,
              outputTokens: 7,
              cacheReadTokens: 0,
              cacheWriteTokens: 2,
              reasoningTokens: 1,
              totalTokens: 10,
            },
          ],
        },
      ],
    });
  });

  it("calculates estimated cost and AI credits for public SKUs", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "claude-sonnet-4.6": {
              requests: { count: 1 },
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cacheReadTokens: 1_000_000,
                cacheWriteTokens: 1_000_000,
              },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });
    const model = summary.models[0];
    const session = summary.sessions[0];

    expect(summary.totals.estimatedCostUsd).toBeCloseTo(22.05);
    expect(summary.totals.estimatedAiCredits).toBeCloseTo(2_205);
    expect(summary.totals.unpricedModelCount).toBe(0);
    expect(summary.unpricedModels).toEqual([]);
    expect(model).toMatchObject({
      model: "claude-sonnet-4.6",
      pricingStatus: "exact",
      pricingSource: "exact",
      pricingKey: "claude-sonnet-4.6",
      pricedAs: "claude-sonnet-4.6",
      billableOutputTokens: 1_000_000,
      reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
    });
    expect(model.costBreakdownUsd).toMatchObject({
      input: 3,
      cachedInput: 0.3,
      cacheWrite: 3.75,
      output: 15,
      reasoning: 0,
    });
    expect(model.costBreakdownUsd.total).toBeCloseTo(22.05);
    expect(model.estimatedCostUsd).toBeCloseTo(22.05);
    expect(model.estimatedAiCredits).toBeCloseTo(2_205);
    expect(session.estimatedCostUsd).toBeCloseTo(22.05);
    expect(session.models[0].estimatedCostUsd).toBeCloseTo(22.05);
  });

  it("uses SDK long-context pricing when Bridge recorded a long context tier", async () => {
    const copilotHome = createCopilotHome();
    const sessionDir = createSession(copilotHome, "session-1");
    writeFileSync(join(sessionDir, "bridge-model-state.json"), JSON.stringify({
      model: "gpt-5.5",
      contextTier: "long_context",
    }));
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cacheReadTokens: 1_000_000,
              },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({
      copilotHome,
      sdkModels: [{
        id: "gpt-5.5",
        name: "GPT-5.5",
        billing: {
          tokenPrices: {
            inputPrice: 500,
            outputPrice: 3000,
            cachePrice: 50,
            batchSize: 1_000_000,
            contextMax: 272_000,
            longContext: {
              inputPrice: 1000,
              outputPrice: 4500,
              cachePrice: 100,
              contextMax: 1_050_000,
            },
          },
        },
      }],
    });

    expect(summary.models[0]).toMatchObject({
      model: "gpt-5.5",
      contextTier: "long_context",
      contextTierLabel: "Long context",
      pricingKey: "gpt-5.5:long_context",
      pricedAs: "gpt-5.5:long_context",
    });
    expect(summary.models[0].costBreakdownUsd).toMatchObject({
      input: 10,
      cachedInput: 1,
      output: 45,
    });
    expect(summary.models[0].estimatedCostUsd).toBeCloseTo(56);
  });

  it("resolves generic model variants through the pricing resolver", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-06T10:00:00.000Z",
        data: {
          modelMetrics: {
            "claude-opus-4.7-context-low": {
              requests: { count: 1 },
              usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });
    const model = summary.models[0];

    expect(model).toMatchObject({
      model: "claude-opus-4.7-context-low",
      pricingStatus: "normalized-variant",
      pricingSource: "normalized-variant",
      pricingKey: "claude-opus-4.7",
      pricedAs: "claude-opus-4.7",
      normalizedPricingModel: "claude-opus-4.7",
    });
    expect(model.estimatedCostUsd).toBeCloseTo(30);
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(30);
  });

  it("resolves arbitrary observed model IDs through supplied SDK display names", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-06T11:00:00.000Z",
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

    const summary = await readCopilotUsageSummary({
      copilotHome,
      sdkModels: [{ id: "opaque-sdk-id", name: "Claude Opus 4.7" }],
    });
    const model = summary.models[0];

    expect(model).toMatchObject({
      model: "opaque-sdk-id",
      pricingStatus: "sdk-name",
      pricingSource: "sdk-name",
      pricingKey: "claude-opus-4.7",
      pricedAs: "claude-opus-4.7",
      normalizedPricingModel: "claude-opus-4.7",
    });
    expect(model.estimatedCostUsd).toBeCloseTo(30);
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(30);
  });

  it("marks unknown models unpriced and excludes them from cost totals", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-07T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: { outputTokens: 1_000_000 },
            },
            "unknown-model": {
              requests: { count: 1 },
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                reasoningTokens: 1_000_000,
              },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });
    const known = summary.models.find((row) => row.model === "gpt-5.5");
    const unknown = summary.models.find((row) => row.model === "unknown-model");

    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      reasoningTokens: 1_000_000,
      totalTokens: 4_000_000,
      billableOutputTokens: 3_000_000,
      unpricedModelCount: 1,
    });
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(30);
    expect(summary.totals.estimatedAiCredits).toBeCloseTo(3_000);
    expect(summary.totals.unpricedTokens).toMatchObject({
      requests: 1,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      totalTokens: 3_000_000,
    });
    expect(known?.estimatedCostUsd).toBeCloseTo(30);
    expect(unknown).toMatchObject({
      pricingStatus: "unpriced",
      pricingSource: "unpriced",
      pricingKey: null,
      pricedAs: null,
      normalizedPricingModel: "unknown-model",
      estimatedCostUsd: 0,
      estimatedAiCredits: 0,
      billableOutputTokens: 2_000_000,
    });
    expect(unknown?.costBreakdownUsd.total).toBe(0);
    expect(summary.unpricedModels).toEqual([
      expect.objectContaining({
        model: "unknown-model",
        requests: 1,
        totalTokens: 3_000_000,
        pricingStatus: "unpriced",
      }),
    ]);
    expect(summary.sessions[0].unpricedModels).toEqual(summary.unpricedModels);
  });

  it("prices reasoning tokens at the output rate and exposes them separately", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-08T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: { outputTokens: 1_000_000, reasoningTokens: 2_000_000 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });
    const model = summary.models[0];

    expect(model).toMatchObject({
      outputTokens: 1_000_000,
      reasoningTokens: 2_000_000,
      billableOutputTokens: 3_000_000,
      reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
    });
    expect(model.costBreakdownUsd.output).toBeCloseTo(30);
    expect(model.costBreakdownUsd.reasoning).toBeCloseTo(60);
    expect(model.costBreakdownUsd.total).toBeCloseTo(90);
    expect(summary.totals.costBreakdownUsd.reasoning).toBeCloseTo(60);
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(90);
  });

  it("tracks skipped sessions and shutdown-based skipped coverage metadata", async () => {
    const copilotHome = createCopilotHome();
    createSession(copilotHome, "session-no-events");
    writeEvents(copilotHome, "session-no-shutdown", [
      { type: "assistant.message", timestamp: "2026-02-01T09:00:00.000Z", data: { content: "still running" } },
    ]);
    writeEvents(copilotHome, "session-empty", [
      {
        type: "session.shutdown",
        timestamp: "2026-02-01T10:00:00.000Z",
        data: { modelMetrics: {} },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.totalTokens).toBe(0);
    expect(summary.coverage).toEqual({
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
      earliestSkippedAt: "2026-02-01T10:00:00.000Z",
      latestSkippedAt: "2026-02-01T10:00:00.000Z",
    });
    expect(summary.models).toEqual([]);
  });

  it("uses assistant message output tokens before a session shutdown is written", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-live", [
      {
        type: "session.start",
        timestamp: "2026-02-02T09:00:00.000Z",
        data: { selectedModel: "gpt-5.5" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-02T09:00:05.000Z",
        data: { requestId: "request-1", outputTokens: 10 },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-02T09:00:06.000Z",
        data: { requestId: "request-1", outputTokens: 12 },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-02T09:01:00.000Z",
        data: { requestId: "request-2", outputTokens: 5 },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.coverage.sessionsIncluded).toBe(1);
    expect(summary.coverage.sessionsSkipped).toBe(0);
    expect(summary.coverage.skippedByReason.no_shutdown).toBe(0);
    expect(summary.coverage.earliestIncludedAt).toBe("2026-02-02T09:00:06.000Z");
    expect(summary.coverage.latestIncludedAt).toBe("2026-02-02T09:01:00.000Z");
    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 0,
      outputTokens: 17,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 17,
    });
    expect(summary.models).toMatchObject([
      {
        model: "gpt-5.5",
        sessions: 1,
        requests: 2,
        inputTokens: 0,
        outputTokens: 17,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 17,
      },
    ]);
    expect(summary.sessions).toMatchObject([
      {
        sessionId: "session-live",
        shutdownAt: "2026-02-02T09:01:00.000Z",
        requests: 2,
        inputTokens: 0,
        outputTokens: 17,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 17,
        models: [
          {
            model: "gpt-5.5",
            sessions: 1,
            requests: 2,
            inputTokens: 0,
            outputTokens: 17,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 17,
          },
        ],
      },
    ]);
  });

  it("attributes live assistant usage after model changes to the switched model", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-live-switch", [
      {
        type: "session.start",
        timestamp: "2026-02-02T09:00:00.000Z",
        data: { selectedModel: "gpt-5.5" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-02T09:00:05.000Z",
        data: { requestId: "request-1", outputTokens: 10 },
      },
      {
        type: "session.model_change",
        timestamp: "2026-02-02T09:00:10.000Z",
        data: { newModel: "claude-opus-4.7" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-02T09:00:15.000Z",
        data: { requestId: "request-2", outputTokens: 7 },
      },
      {
        type: "session.resume",
        timestamp: "2026-02-02T09:00:20.000Z",
        data: { selectedModel: "gpt-5.4" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-02T09:00:25.000Z",
        data: { requestId: "request-3", outputTokens: 5 },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 3,
      outputTokens: 22,
      totalTokens: 22,
    });
    expect(summary.models).toEqual([
      expect.objectContaining({ model: "gpt-5.5", requests: 1, outputTokens: 10, totalTokens: 10 }),
      expect.objectContaining({ model: "claude-opus-4.7", requests: 1, outputTokens: 7, totalTokens: 7 }),
      expect.objectContaining({ model: "gpt-5.4", requests: 1, outputTokens: 5, totalTokens: 5 }),
    ]);
    expect(summary.sessions[0].models.map((row) => row.model)).toEqual([
      "gpt-5.5",
      "claude-opus-4.7",
      "gpt-5.4",
    ]);
  });

  it("uses assistant message model metadata when live usage events include it", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-live-message-model", [
      {
        type: "session.start",
        timestamp: "2026-02-02T09:00:00.000Z",
        data: { selectedModel: "gpt-5.5" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-02T09:00:05.000Z",
        data: { model: "claude-opus-4.7", requestId: "request-1", outputTokens: 10 },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-02T09:00:06.000Z",
        data: { model: "claude-opus-4.7", requestId: "request-1", outputTokens: 12 },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.models).toEqual([
      expect.objectContaining({ model: "claude-opus-4.7", requests: 1, outputTokens: 12, totalTokens: 12 }),
    ]);
  });

  it("prefers shutdown model metrics over assistant message output tokens", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.start",
        timestamp: "2026-02-03T09:00:00.000Z",
        data: { selectedModel: "gpt-5.5" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-02-03T09:01:00.000Z",
        data: { requestId: "request-1", outputTokens: 100 },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-02-03T09:02:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: { outputTokens: 20 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.totalTokens).toBe(20);
    expect(summary.totals.outputTokens).toBe(20);
    expect(summary.totals.requests).toBe(1);
    expect(summary.sessions[0].shutdownAt).toBe("2026-02-03T09:02:00.000Z");
  });

  it("accumulates usable shutdowns and ignores empty later shutdowns", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-03-01T08:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 10 },
              usage: { inputTokens: 100, outputTokens: 50 },
            },
          },
        },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-03-01T08:30:00.000Z",
        data: { modelMetrics: {} },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-03-01T09:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 1 },
              usage: { outputTokens: 5 },
            },
            "o3": {
              usage: { reasoningTokens: 4 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 11,
      inputTokens: 100,
      outputTokens: 55,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 4,
      totalTokens: 159,
    });
    expect(summary.coverage.earliestIncludedAt).toBe("2026-03-01T08:00:00.000Z");
    expect(summary.coverage.latestIncludedAt).toBe("2026-03-01T09:00:00.000Z");
    expect(summary.models.map((row) => row.model)).toEqual(["gpt-4o", "o3"]);
  });

  it("accumulates every usable shutdown summary in a non-active session file", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-03-05T08:00:00.000Z",
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
        timestamp: "2026-03-05T08:05:00.000Z",
        data: { role: "assistant" },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-03-05T09:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 1 },
              usage: { outputTokens: 4 },
            },
            "o3": {
              requests: { count: 1 },
              usage: { reasoningTokens: 6 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 4,
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 6,
      totalTokens: 23,
    });
    expect(summary.coverage.sessionsIncluded).toBe(1);
    expect(summary.coverage.earliestIncludedAt).toBe("2026-03-05T08:00:00.000Z");
    expect(summary.coverage.latestIncludedAt).toBe("2026-03-05T09:00:00.000Z");
    expect(summary.models).toMatchObject([
      {
        model: "gpt-4o",
        sessions: 1,
        requests: 3,
        inputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 17,
      },
      {
        model: "o3",
        sessions: 1,
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 6,
        totalTokens: 6,
      },
    ]);
  });

  it("keeps persisted shutdown summaries when a later active tail exists", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-03-06T08:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 10 },
            },
          },
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-03-06T08:05:00.000Z",
        data: { content: "session still active" },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 10,
    });
    expect(summary.coverage.sessionsIncluded).toBe(1);
    expect(summary.coverage.sessionsSkipped).toBe(0);
    expect(summary.coverage.skippedByReason.no_shutdown).toBe(0);
    expect(summary.coverage.earliestIncludedAt).toBe("2026-03-06T08:00:00.000Z");
    expect(summary.coverage.latestIncludedAt).toBe("2026-03-06T08:00:00.000Z");
    expect(summary.coverage.earliestSkippedAt).toBeNull();
    expect(summary.coverage.latestSkippedAt).toBeNull();
  });

  it("drops malformed shutdown timestamps from coverage windows without losing usage totals", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "definitely-not-a-date",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 9, outputTokens: 4 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 9,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 13,
    });
    expect(summary.coverage.sessionsIncluded).toBe(1);
    expect(summary.coverage.earliestIncludedAt).toBeNull();
    expect(summary.coverage.latestIncludedAt).toBeNull();
    expect(summary.coverage.earliestSkippedAt).toBeNull();
    expect(summary.coverage.latestSkippedAt).toBeNull();
  });

  it("keeps persisted shutdown summaries when malformed tail lines are present", async () => {
    const copilotHome = createCopilotHome();
    writeRawEvents(copilotHome, "session-1", [
      JSON.stringify({
        type: "session.shutdown",
        timestamp: "2026-04-01T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 12 },
            },
          },
        },
      }),
      "{not valid json",
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 12,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 12,
    });
    expect(summary.coverage.sessionsIncluded).toBe(1);
    expect(summary.coverage.sessionsSkipped).toBe(0);
    expect(summary.coverage.skippedByReason.parse_error).toBe(0);
    expect(summary.coverage.earliestIncludedAt).toBe("2026-04-01T10:00:00.000Z");
    expect(summary.coverage.latestIncludedAt).toBe("2026-04-01T10:00:00.000Z");
  });

  it("ignores malformed lines before later shutdown summaries", async () => {
    const copilotHome = createCopilotHome();
    writeRawEvents(copilotHome, "session-1", [
      JSON.stringify({
        type: "session.shutdown",
        timestamp: "2026-04-02T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 1 },
              usage: { inputTokens: 5 },
            },
          },
        },
      }),
      "{not valid json",
      JSON.stringify({
        type: "session.shutdown",
        timestamp: "2026-04-02T11:00:00.000Z",
        data: {
          modelMetrics: {
            o3: {
              requests: { count: 1 },
              usage: { reasoningTokens: 4 },
            },
          },
        },
      }),
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 4,
      totalTokens: 9,
    });
    expect(summary.coverage.sessionsIncluded).toBe(1);
    expect(summary.coverage.earliestIncludedAt).toBe("2026-04-02T10:00:00.000Z");
    expect(summary.coverage.latestIncludedAt).toBe("2026-04-02T11:00:00.000Z");
  });

  it("returns an empty summary when session-state is missing", async () => {
    const missingHome = createCopilotHome();
    const missingSummary = await readCopilotUsageSummary({ copilotHome: missingHome });

    expect(missingSummary.coverage.sessionsSeen).toBe(0);
    expect(missingSummary.models).toEqual([]);
  });

  it("throws a safe error when the top-level session-state is unreadable", async () => {
    const unreadableHome = createCopilotHome();
    writeFileSync(join(unreadableHome, "session-state"), "not a directory");
    await expect(readCopilotUsageSummary({ copilotHome: unreadableHome }))
      .rejects.toThrow(CopilotUsageReadError);
    await expect(readCopilotUsageSummary({ copilotHome: unreadableHome }))
      .rejects.toThrow("Unable to read local Copilot usage history.");
  });
});

describe("createCopilotUsageReader", () => {
  it("reuses cached summaries until refreshed", async () => {
    const copilotHome = createCopilotHome();
    let currentTime = Date.parse("2026-05-01T00:00:00.000Z");
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 1 },
              usage: { inputTokens: 10 },
            },
          },
        },
      },
    ]);

    const reader = createCopilotUsageReader({
      copilotHome,
      ttlMs: 60_000,
      now: () => currentTime,
    });

    const initial = await reader.readSummary();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T11:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 20 },
            },
          },
        },
      },
    ]);

    const cached = await reader.readSummary();
    expect(cached).toBe(initial);
    expect(cached.totals.inputTokens).toBe(10);

    const refreshed = await reader.readSummary({ refresh: true });
    expect(refreshed).not.toBe(initial);
    expect(refreshed.totals.inputTokens).toBe(20);

    currentTime += 61_000;
    const expired = await reader.readSummary();
    expect(expired.totals.inputTokens).toBe(20);
  });

  it("loads SDK metadata on uncached reads and refreshes", async () => {
    const sdkModels = [{ id: "opaque-sdk-id", name: "Claude Opus 4.7" }] as const;
    const loadOptions: ReadCopilotUsageSummaryOptions[] = [];
    const initialSummary = emptySummary("2026-05-01T00:00:01.000Z");
    const refreshedSummary = emptySummary("2026-05-01T00:00:02.000Z");
    const loader = vi.fn((options: ReadCopilotUsageSummaryOptions): Promise<CopilotUsageSummary> => {
      loadOptions.push(options);
      return Promise.resolve(loadOptions.length === 1 ? initialSummary : refreshedSummary);
    });
    const provider = vi.fn(async () => sdkModels);
    const reader = createCopilotUsageReader({
      copilotHome: createCopilotHome(),
      ttlMs: 60_000,
      now: () => Date.parse("2026-05-01T00:00:00.000Z"),
      loadSummary: loader,
      modelMetadataProvider: provider,
    });

    await expect(reader.readSummary()).resolves.toBe(initialSummary);
    await expect(reader.readSummary()).resolves.toBe(initialSummary);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loadOptions[0]?.sdkModels).toEqual(sdkModels);

    await expect(reader.readSummary({ refresh: true })).resolves.toBe(refreshedSummary);

    expect(provider).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loadOptions[1]?.sdkModels).toEqual(sdkModels);
  });

  it("keeps the newest load cached when an older inflight request resolves later", async () => {
    let currentTime = Date.parse("2026-05-02T00:00:00.000Z");
    const pending: Array<{ resolve: (summary: CopilotUsageSummary) => void }> = [];
    const loader = vi.fn((_options) => new Promise<CopilotUsageSummary>((resolve) => {
      pending.push({ resolve });
    }));
    const reader = createCopilotUsageReader({
      copilotHome: createCopilotHome(),
      ttlMs: 60_000,
      now: () => currentTime,
      loadSummary: loader,
    });

    const stalePromise = reader.readSummary();
    const refreshedPromise = reader.readSummary({ refresh: true });

    expect(loader).toHaveBeenCalledTimes(2);

    const staleSummary: CopilotUsageSummary = {
      generatedAt: "2026-05-02T00:00:01.000Z",
      totals: summaryTotals({
        requests: 1,
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 10,
      }),
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
        earliestIncludedAt: "2026-05-02T00:00:00.000Z",
        latestIncludedAt: "2026-05-02T00:00:00.000Z",
        earliestSkippedAt: null,
        latestSkippedAt: null,
      },
      models: [],
      sessions: [],
      unpricedModels: [],
    };
    const refreshedSummary: CopilotUsageSummary = {
      ...staleSummary,
      generatedAt: "2026-05-02T00:00:02.000Z",
      totals: summaryTotals({
        requests: 2,
        inputTokens: 20,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 20,
      }),
    };

    pending[1].resolve(refreshedSummary);
    await expect(refreshedPromise).resolves.toBe(refreshedSummary);

    pending[0].resolve(staleSummary);
    await expect(stalePromise).resolves.toBe(staleSummary);

    currentTime += 1_000;
    await expect(reader.readSummary()).resolves.toBe(refreshedSummary);
  });
});
