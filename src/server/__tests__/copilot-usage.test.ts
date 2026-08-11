import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CopilotUsageReadError,
  readCopilotUsageSummary,
  type CopilotUsageSummary,
  type CopilotUsageTotals,
} from "../copilot-usage.js";
import { COPILOT_USAGE_UNATTRIBUTED_MODEL } from "../../shared/copilot-usage.js";
import { makeTestDir } from "./helpers.js";

const REASONING_PRICING_ASSUMPTION = "reasoning_tokens_included_in_output" as const;

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

// Builds a priceable SDK model whose token prices (cents-per-batch, batchSize 1M)
// convert to round USD-per-1M rates: 100 cents => $1/1M.
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

function zeroTotals(): CopilotUsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    meteredAiCredits: 0,
    meteredTokens: 0,
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
    // Reasoning tokens are already inside outputTokens, so output is the whole
    // billable amount.
    billableOutputTokens: totals.outputTokens,
    reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
    unpricedModelCount: 0,
    unpricedTokens: zeroTotals(),
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
        uncachedInputTokens: 15,
        outputTokens: 12,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
        totalTokens: 32,
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
          uncachedInputTokens: 15,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 23,
        },
        {
          model: "claude-sonnet",
          sessions: 1,
          requests: 1,
          inputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 2,
          reasoningTokens: 1,
          totalTokens: 9,
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
          uncachedInputTokens: 7,
          outputTokens: 12,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          reasoningTokens: 1,
          totalTokens: 24,
          models: [
            {
              model: "gpt-4o",
              sessions: 1,
              requests: 2,
              inputTokens: 10,
              uncachedInputTokens: 7,
              outputTokens: 5,
              cacheReadTokens: 3,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 15,
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
              totalTokens: 9,
            },
          ],
        },
      ],
    });
  });

  it("calculates estimated cost and AI credits from SDK token prices", async () => {
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
                // inputTokens is inclusive of cache reads and cache writes, so
                // only 1M of this is uncached and billed at the input rate.
                inputTokens: 3_000_000,
                outputTokens: 1_000_000,
                cacheReadTokens: 1_000_000,
                cacheWriteTokens: 1_000_000,
              },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({
      copilotHome,
      sdkModels: [sdkPriceableModel("claude-sonnet-4.6", { input: 3, output: 15, cache: 0.3 }, "Claude Sonnet 4.6")],
    });
    const model = summary.models[0];
    const session = summary.sessions[0];

    // Cache writes bill at 1.25x the input rate even though the SDK price card
    // carries no explicit cache-write field.
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(22.05);
    expect(summary.totals.estimatedAiCredits).toBeCloseTo(2_205);
    expect(summary.totals.unpricedModelCount).toBe(0);
    expect(summary.unpricedModels).toEqual([]);
    expect(model).toMatchObject({
      model: "claude-sonnet-4.6",
      pricingStatus: "exact",
      pricingKey: "claude-sonnet-4.6",
      pricedAs: "claude-sonnet-4.6",
      uncachedInputTokens: 1_000_000,
      totalTokens: 4_000_000,
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

  it("prefers the reported uncached input count over subtracting cache tokens", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: {
                inputTokens: 2_000_000,
                outputTokens: 10,
                cacheReadTokens: 1_500_000,
                cacheWriteTokens: 400_000,
              },
              tokenDetails: {
                input: { tokenCount: 100_000 },
                cache_read: { tokenCount: 1_500_000 },
                cache_write: { tokenCount: 400_000 },
                output: { tokenCount: 10 },
              },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.uncachedInputTokens).toBe(100_000);
    expect(summary.totals.totalTokens).toBe(2_000_010);
  });

  it("falls back to subtraction when tokenDetails does not reconcile with usage", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: { inputTokens: 900, outputTokens: 10, cacheReadTokens: 400 },
              // Captured a beat apart from usage, so it must not be trusted.
              tokenDetails: { input: { tokenCount: 12_345 } },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.uncachedInputTokens).toBe(500);
    expect(summary.totals.totalTokens).toBe(910);
  });

  it("never reports negative uncached input when cache counts exceed the reported input", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: { inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.uncachedInputTokens).toBe(0);
  });

  it("carries GitHub's metered cost through as forward progress only", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: { inputTokens: 100, outputTokens: 10 },
              totalNanoAiu: 250_000_000_000,
            },
          },
        },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T11:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 2 },
              usage: { inputTokens: 180, outputTokens: 30 },
              totalNanoAiu: 400_000_000_000,
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    // Snapshots are cumulative, so the later 400 AIU replaces the earlier 250.
    expect(summary.totals.meteredAiCredits).toBeCloseTo(400);
    expect(summary.models[0].meteredAiCredits).toBeCloseTo(400);
    expect(summary.totals.meteredTokens).toBe(summary.totals.totalTokens);
  });

  it("uses the top-level metered total and carries the unattributed remainder into daily rows", async () => {
    const copilotHome = createCopilotHome();
    const shutdownAt = (day: number) => new Date(2026, 7, day, 10, 0, 0).toISOString();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: shutdownAt(6),
        data: {
          totalNanoAiu: 407_200_000_000,
          modelMetrics: {
            "claude-opus-5": {
              requests: { count: 1 },
              usage: { inputTokens: 100 },
              totalNanoAiu: 407_200_000_000,
            },
          },
        },
      },
      {
        type: "session.shutdown",
        timestamp: shutdownAt(7),
        data: {
          totalNanoAiu: 10_025_100_000_000,
          modelMetrics: {
            "claude-opus-5": {
              requests: { count: 2 },
              usage: { inputTokens: 200 },
              totalNanoAiu: 1_901_500_000_000,
            },
          },
        },
      },
      {
        type: "session.shutdown",
        timestamp: shutdownAt(11),
        data: {
          totalNanoAiu: 34_013_900_000_000,
          modelMetrics: {
            "claude-opus-5": {
              requests: { count: 3 },
              usage: { inputTokens: 300 },
              totalNanoAiu: 11_321_200_000_000,
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });
    const named = summary.models.find((row) => row.model === "claude-opus-5");
    const unattributed = summary.models.find((row) => row.model === COPILOT_USAGE_UNATTRIBUTED_MODEL);

    expect(summary.totals.meteredAiCredits).toBeCloseTo(34_013.9);
    expect(named?.meteredAiCredits).toBeCloseTo(11_321.2);
    expect(unattributed).toMatchObject({
      requests: 0,
      totalTokens: 0,
      meteredTokens: 0,
    });
    expect(unattributed?.meteredAiCredits).toBeCloseTo(22_692.7);
    expect(summary.models.reduce((total, row) => total + row.meteredAiCredits, 0))
      .toBeCloseTo(summary.totals.meteredAiCredits);
    expect(summary.totals.unpricedModelCount).toBe(1);
    expect(summary.unpricedModels.map((row) => row.model)).toEqual(["claude-opus-5"]);

    expect(summary.days.map((day) => day.date)).toEqual([
      "2026-08-06",
      "2026-08-07",
      "2026-08-11",
    ]);
    expect(summary.days[0].meteredAiCredits).toBeCloseTo(407.2);
    expect(summary.days[1].meteredAiCredits).toBeCloseTo(9_617.9);
    expect(summary.days[2].meteredAiCredits).toBeCloseTo(23_988.8);
    for (const day of summary.days) {
      expect(day.models.reduce((total, row) => total + row.meteredAiCredits, 0))
        .toBeCloseTo(day.meteredAiCredits);
    }
    expect(summary.sessions[0].meteredAiCredits).toBeCloseTo(34_013.9);
    expect(summary.sessions[0].days?.[0].meteredAiCredits).toBeCloseTo(407.2);
    expect(summary.sessions[0].days?.[1].meteredAiCredits).toBeCloseTo(9_617.9);
    expect(summary.sessions[0].days?.[2].meteredAiCredits).toBeCloseTo(23_988.8);
  });

  it("keeps named model metering within an authoritative top-level total", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-08-11T21:45:10.000Z",
        data: {
          totalNanoAiu: 100_000_000_000,
          modelMetrics: {
            "model-a": {
              requests: { count: 1 },
              usage: { inputTokens: 80 },
              totalNanoAiu: 80_000_000_000,
            },
            "model-b": {
              requests: { count: 1 },
              usage: { inputTokens: 70 },
              totalNanoAiu: 70_000_000_000,
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.meteredAiCredits).toBeCloseTo(100);
    expect(summary.models).toHaveLength(2);
    expect(summary.models.reduce((total, row) => total + row.meteredAiCredits, 0)).toBeCloseTo(100);
    expect(summary.models.some((row) => row.model === COPILOT_USAGE_UNATTRIBUTED_MODEL)).toBe(false);
  });

  it("reconciles model metering from missing-top-level snapshots when an authoritative total arrives", async () => {
    const copilotHome = createCopilotHome();
    const shutdownAt = (day: number) => new Date(2026, 7, day, 10, 0, 0).toISOString();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: shutdownAt(10),
        data: {
          modelMetrics: {
            "model-a": {
              requests: { count: 1 },
              usage: { inputTokens: 80 },
              totalNanoAiu: 80_000_000_000,
            },
          },
        },
      },
      {
        type: "session.shutdown",
        timestamp: shutdownAt(11),
        data: {
          totalNanoAiu: 100_000_000_000,
          modelMetrics: {
            "model-a": {
              requests: { count: 2 },
              usage: { inputTokens: 150 },
              totalNanoAiu: 150_000_000_000,
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.meteredAiCredits).toBeCloseTo(100);
    expect(summary.models[0].meteredAiCredits).toBeCloseTo(100);
    expect(summary.days[0].meteredAiCredits).toBeCloseTo(80 * (2 / 3));
    expect(summary.days[1].meteredAiCredits).toBeCloseTo(70 * (2 / 3));
    expect(summary.days.reduce((total, day) => total + day.meteredAiCredits, 0)).toBeCloseTo(100);
  });

  it("indexes top-level metering even when the shutdown has no model breakdown", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-08-11T21:45:10.000Z",
        data: {
          totalNanoAiu: 125_000_000_000,
          modelMetrics: {},
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.coverage.sessionsIncluded).toBe(1);
    expect(summary.coverage.skippedByReason.empty_model_metrics).toBe(0);
    expect(summary.totals.meteredAiCredits).toBe(125);
    expect(summary.models).toEqual([
      expect.objectContaining({
        model: COPILOT_USAGE_UNATTRIBUTED_MODEL,
        sessions: 1,
        meteredAiCredits: 125,
      }),
    ]);
    expect(summary.days[0]).toMatchObject({ date: "2026-08-11", meteredAiCredits: 125 });
  });

  it("tracks metered coverage separately so a partly metered range is not read as complete", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "metered-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              usage: { inputTokens: 100, outputTokens: 10 },
              totalNanoAiu: 300_000_000_000,
            },
          },
        },
      },
    ]);
    writeEvents(copilotHome, "legacy-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T11:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": { requests: { count: 1 }, usage: { inputTokens: 300, outputTokens: 40 } },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.totalTokens).toBe(450);
    expect(summary.totals.meteredTokens).toBe(110);
    expect(summary.totals.meteredAiCredits).toBeCloseTo(300);
  });

  it("keeps metered coverage when GitHub genuinely billed zero", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "free-alpha": {
              requests: { count: 1 },
              usage: { inputTokens: 100, outputTokens: 10 },
              totalNanoAiu: 0,
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.meteredAiCredits).toBe(0);
    expect(summary.totals.meteredTokens).toBe(110);
  });

  it("reports zero metered credits for sessions logged before the field existed", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-05T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": { requests: { count: 1 }, usage: { inputTokens: 100, outputTokens: 10 } },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals.meteredAiCredits).toBe(0);
    expect(summary.totals.meteredTokens).toBe(0);
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
                inputTokens: 2_000_000,
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
              contextMax: 922_000,
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

    const summary = await readCopilotUsageSummary({
      copilotHome,
      sdkModels: [sdkPriceableModel("claude-opus-4.7", { input: 5, output: 25, cache: 0.5 }, "Claude Opus 4.7")],
    });
    const model = summary.models[0];

    expect(model).toMatchObject({
      model: "claude-opus-4.7-context-low",
      pricingStatus: "sdk-name",
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
      sdkModels: [
        { id: "opaque-sdk-id", name: "Claude Opus 4.7" },
        sdkPriceableModel("claude-opus-4.7", { input: 5, output: 25, cache: 0.5 }, "Claude Opus 4.7"),
      ],
    });
    const model = summary.models[0];

    expect(model).toMatchObject({
      model: "opaque-sdk-id",
      pricingStatus: "sdk-name",
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

    const summary = await readCopilotUsageSummary({
      copilotHome,
      sdkModels: [sdkPriceableModel("gpt-5.5", { input: 5, output: 30, cache: 0.5 }, "GPT-5.5")],
    });
    const known = summary.models.find((row) => row.model === "gpt-5.5");
    const unknown = summary.models.find((row) => row.model === "unknown-model");

    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 1_000_000,
      uncachedInputTokens: 1_000_000,
      outputTokens: 2_000_000,
      reasoningTokens: 1_000_000,
      totalTokens: 3_000_000,
      billableOutputTokens: 2_000_000,
      unpricedModelCount: 1,
    });
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(30);
    expect(summary.totals.estimatedAiCredits).toBeCloseTo(3_000);
    expect(summary.totals.unpricedTokens).toMatchObject({
      requests: 1,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      totalTokens: 2_000_000,
    });
    expect(known?.estimatedCostUsd).toBeCloseTo(30);
    expect(unknown).toMatchObject({
      pricingStatus: "unpriced",
      pricingKey: null,
      pricedAs: null,
      normalizedPricingModel: "unknown-model",
      estimatedCostUsd: 0,
      estimatedAiCredits: 0,
      billableOutputTokens: 1_000_000,
    });
    expect(unknown?.costBreakdownUsd.total).toBe(0);
    expect(summary.unpricedModels).toEqual([
      expect.objectContaining({
        model: "unknown-model",
        requests: 1,
        totalTokens: 2_000_000,
        pricingStatus: "unpriced",
      }),
    ]);
    expect(summary.sessions[0].unpricedModels).toEqual(summary.unpricedModels);
  });

  it("does not bill reasoning tokens again because they are already inside output tokens", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-01-08T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.5": {
              requests: { count: 1 },
              // Reasoning is a subset of output, not an additional bucket.
              usage: { outputTokens: 3_000_000, reasoningTokens: 2_000_000 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({
      copilotHome,
      sdkModels: [sdkPriceableModel("gpt-5.5", { input: 5, output: 30, cache: 0.5 }, "GPT-5.5")],
    });
    const model = summary.models[0];

    expect(model).toMatchObject({
      outputTokens: 3_000_000,
      reasoningTokens: 2_000_000,
      totalTokens: 3_000_000,
      billableOutputTokens: 3_000_000,
      reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
    });
    expect(model.costBreakdownUsd.output).toBeCloseTo(90);
    expect(model.costBreakdownUsd.reasoning).toBe(0);
    expect(model.costBreakdownUsd.total).toBeCloseTo(90);
    expect(summary.totals.costBreakdownUsd.reasoning).toBe(0);
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

  it("counts only forward progress and ignores empty later shutdowns", async () => {
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
              requests: { count: 11 },
              usage: { inputTokens: 140, outputTokens: 55 },
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
      inputTokens: 140,
      uncachedInputTokens: 140,
      outputTokens: 55,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 4,
      totalTokens: 195,
    });
    expect(summary.coverage.earliestIncludedAt).toBe("2026-03-01T08:00:00.000Z");
    expect(summary.coverage.latestIncludedAt).toBe("2026-03-01T09:00:00.000Z");
    expect(summary.models.map((row) => row.model)).toEqual(["gpt-4o", "o3"]);
  });

  it("does not double count a resumed session that rewrites cumulative shutdown snapshots", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-03-04T08:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 100 },
              usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 500 },
            },
          },
        },
      },
      { type: "session.resume", timestamp: "2026-03-04T09:00:00.000Z", data: {} },
      {
        type: "session.shutdown",
        timestamp: "2026-03-04T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 250 },
              usage: { inputTokens: 3_000, outputTokens: 450, cacheReadTokens: 1_400 },
            },
          },
        },
      },
      { type: "session.resume", timestamp: "2026-03-04T11:00:00.000Z", data: {} },
      {
        type: "session.shutdown",
        timestamp: "2026-03-04T12:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 320 },
              usage: { inputTokens: 4_100, outputTokens: 600, cacheReadTokens: 1_900 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 320,
      inputTokens: 4_100,
      uncachedInputTokens: 2_200,
      outputTokens: 600,
      cacheReadTokens: 1_900,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 4_700,
    });
    expect(summary.models).toMatchObject([{ model: "gpt-4o", sessions: 1, requests: 320 }]);
  });

  it("treats a decreasing shutdown snapshot as a restarted counter", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "session-1", [
      {
        type: "session.shutdown",
        timestamp: "2026-03-04T08:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 40 },
              usage: { inputTokens: 900, outputTokens: 120 },
            },
          },
        },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-03-04T10:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 7 },
              usage: { inputTokens: 150, outputTokens: 30 },
            },
          },
        },
      },
    ]);

    const summary = await readCopilotUsageSummary({ copilotHome });

    expect(summary.totals).toMatchObject({
      requests: 47,
      inputTokens: 1_050,
      outputTokens: 150,
      totalTokens: 1_200,
    });
  });

  it("accumulates forward progress per model in a non-active session file", async () => {
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
              requests: { count: 3 },
              usage: { inputTokens: 10, outputTokens: 7 },
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
      uncachedInputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 6,
      totalTokens: 17,
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
        totalTokens: 0,
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

  it("keeps persisted shutdown summaries around malformed lines wherever they appear", async () => {
    const shutdown = (timestamp: string, model: string, usage: Record<string, number>, count = 1) =>
      JSON.stringify({
        type: "session.shutdown",
        timestamp,
        data: { modelMetrics: { [model]: { requests: { count }, usage } } },
      });

    // Malformed trailing line after a valid shutdown summary.
    const trailing = createCopilotHome();
    writeRawEvents(trailing, "session-1", [
      shutdown("2026-04-01T10:00:00.000Z", "gpt-4o", { inputTokens: 12 }, 2),
      "{not valid json",
    ]);
    const trailingSummary = await readCopilotUsageSummary({ copilotHome: trailing });
    expect(trailingSummary.totals).toMatchObject({
      requests: 2,
      inputTokens: 12,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 12,
    });
    expect(trailingSummary.coverage.sessionsIncluded).toBe(1);
    expect(trailingSummary.coverage.sessionsSkipped).toBe(0);
    expect(trailingSummary.coverage.skippedByReason.parse_error).toBe(0);
    expect(trailingSummary.coverage.earliestIncludedAt).toBe("2026-04-01T10:00:00.000Z");
    expect(trailingSummary.coverage.latestIncludedAt).toBe("2026-04-01T10:00:00.000Z");

    // Malformed line sandwiched between two valid shutdown summaries.
    const sandwiched = createCopilotHome();
    writeRawEvents(sandwiched, "session-1", [
      shutdown("2026-04-02T10:00:00.000Z", "gpt-4o", { inputTokens: 5 }),
      "{not valid json",
      shutdown("2026-04-02T11:00:00.000Z", "o3", { reasoningTokens: 4 }),
    ]);
    const sandwichedSummary = await readCopilotUsageSummary({ copilotHome: sandwiched });
    expect(sandwichedSummary.totals).toMatchObject({
      requests: 2,
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 4,
      totalTokens: 5,
    });
    expect(sandwichedSummary.coverage.sessionsIncluded).toBe(1);
    expect(sandwichedSummary.coverage.earliestIncludedAt).toBe("2026-04-02T10:00:00.000Z");
    expect(sandwichedSummary.coverage.latestIncludedAt).toBe("2026-04-02T11:00:00.000Z");
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

describe("copilot usage time ranges", () => {
  // Fixed local anchor so month/year boundaries are deterministic in any timezone.
  const NOW = new Date(2026, 4, 15, 12, 0, 0);
  const now = () => NOW.getTime();

  function localIso(year: number, monthIndex: number, day: number): string {
    return new Date(year, monthIndex, day, 9, 0, 0).toISOString();
  }

  function shutdown(timestamp: string, cumulativeInputTokens: number) {
    return {
      type: "session.shutdown",
      timestamp,
      data: {
        modelMetrics: {
          "gpt-5.4": {
            requests: { count: 1 },
            usage: { inputTokens: cumulativeInputTokens },
          },
        },
      },
    };
  }

  function writeRangeSession(copilotHome: string): void {
    // Cumulative snapshots, so each shutdown contributes its own daily delta.
    writeEvents(copilotHome, "ranged-session", [
      shutdown(localIso(2025, 10, 5), 100),
      shutdown(localIso(2026, 1, 10), 300),
      shutdown(localIso(2026, 3, 25), 700),
      shutdown(localIso(2026, 4, 12), 1_500),
    ]);
  }

  it("splits a long-lived session across windows by the day usage was recorded", async () => {
    const copilotHome = createCopilotHome();
    writeRangeSession(copilotHome);

    const windows = await Promise.all(
      (["all", "ytd", "mtd", "28d", "7d"] as const).map(
        (range) => readCopilotUsageSummary({ copilotHome, now, range }),
      ),
    );
    const [all, ytd, mtd, past28, past7] = windows;

    expect(all.totals.inputTokens).toBe(1_500);
    expect(ytd.totals.inputTokens).toBe(1_400);
    expect(mtd.totals.inputTokens).toBe(800);
    expect(past28.totals.inputTokens).toBe(1_200);
    expect(past7.totals.inputTokens).toBe(800);
    expect(past7.models).toEqual([expect.objectContaining({ model: "gpt-5.4", sessions: 1, inputTokens: 800 })]);
  });

  it("reports the resolved window and defaults to all time", async () => {
    const copilotHome = createCopilotHome();
    writeRangeSession(copilotHome);

    const defaulted = await readCopilotUsageSummary({ copilotHome, now });
    expect(defaulted.range).toEqual({ key: "all", label: "All time", startAt: null, startDate: null });

    const mtd = await readCopilotUsageSummary({ copilotHome, now, range: "mtd" });
    expect(mtd.range.key).toBe("mtd");
    expect(mtd.range.startDate).toBe("2026-05-01");
    expect(mtd.range.startAt).toBe(new Date(2026, 4, 1, 0, 0, 0, 0).toISOString());

    const past7 = await readCopilotUsageSummary({ copilotHome, now, range: "7d" });
    expect(past7.range.startDate).toBe("2026-05-09");
  });

  it("drops sessions with no usage inside the window from coverage", async () => {
    const copilotHome = createCopilotHome();
    writeRangeSession(copilotHome);
    writeEvents(copilotHome, "stale-session", [shutdown(localIso(2025, 6, 1), 500)]);

    const all = await readCopilotUsageSummary({ copilotHome, now, range: "all" });
    expect(all.coverage.sessionsIncluded).toBe(2);
    expect(all.totals.inputTokens).toBe(2_000);

    const ytd = await readCopilotUsageSummary({ copilotHome, now, range: "ytd" });
    expect(ytd.coverage.sessionsIncluded).toBe(1);
    expect(ytd.coverage.sessionsSeen).toBe(1);
    expect(ytd.totals.inputTokens).toBe(1_400);
    expect(ytd.coverage.earliestIncludedAt).toBe(localIso(2026, 1, 10));
    expect(ytd.coverage.latestIncludedAt).toBe(localIso(2026, 4, 12));
  });

  it("buckets live assistant usage by day when no shutdown summary exists yet", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "live-session", [
      { type: "session.start", timestamp: localIso(2026, 3, 20), data: { selectedModel: "gpt-5.4" } },
      {
        type: "assistant.message",
        timestamp: localIso(2026, 3, 20),
        data: { requestId: "req-old", outputTokens: 40 },
      },
      {
        type: "assistant.message",
        timestamp: localIso(2026, 4, 14),
        data: { requestId: "req-new", outputTokens: 60 },
      },
    ]);

    const all = await readCopilotUsageSummary({ copilotHome, now, range: "all" });
    expect(all.totals.outputTokens).toBe(100);

    const past7 = await readCopilotUsageSummary({ copilotHome, now, range: "7d" });
    expect(past7.totals.outputTokens).toBe(60);
    expect(past7.totals.requests).toBe(1);
  });
});

describe("copilot usage window session counting", () => {
  const NOW = new Date(2026, 4, 15, 12, 0, 0);
  const now = () => NOW.getTime();

  function localIso(year: number, monthIndex: number, day: number): string {
    return new Date(year, monthIndex, day, 9, 0, 0).toISOString();
  }

  // Each shutdown snapshot repeats cumulative totals for every model the session
  // has ever used, so a resume with no new work on that model yields a zero delta.
  function multiModelShutdown(
    timestamp: string,
    cumulative: { old: number; current: number },
  ) {
    return {
      type: "session.shutdown",
      timestamp,
      data: {
        modelMetrics: {
          "gpt-5.4": { requests: { count: 1 }, usage: { inputTokens: cumulative.old } },
          "claude-opus-5": { requests: { count: 1 }, usage: { inputTokens: cumulative.current } },
        },
      },
    };
  }

  it("excludes sessions whose only in-window snapshots repeat unchanged totals", async () => {
    const copilotHome = createCopilotHome();
    // gpt-5.4 did all its work in January and none since; the May shutdown just
    // repeats its unchanged cumulative snapshot alongside real claude usage.
    writeEvents(copilotHome, "resumed-session", [
      multiModelShutdown(localIso(2026, 0, 10), { old: 900, current: 0 }),
      multiModelShutdown(localIso(2026, 4, 12), { old: 900, current: 400 }),
    ]);
    // A session that only ever replays an unchanged snapshot inside the window.
    writeEvents(copilotHome, "idle-session", [
      multiModelShutdown(localIso(2026, 0, 11), { old: 500, current: 0 }),
      multiModelShutdown(localIso(2026, 4, 13), { old: 500, current: 0 }),
    ]);

    const all = await readCopilotUsageSummary({ copilotHome, now, range: "all" });
    expect(all.coverage.sessionsIncluded).toBe(2);
    expect(all.totals.inputTokens).toBe(1_800);

    const past7 = await readCopilotUsageSummary({ copilotHome, now, range: "7d" });
    // Only the session with real in-window work counts, and only for that model.
    expect(past7.coverage.sessionsIncluded).toBe(1);
    expect(past7.totals.inputTokens).toBe(400);
    expect(past7.models).toEqual([
      expect.objectContaining({ model: "claude-opus-5", sessions: 1, inputTokens: 400 }),
    ]);
    expect(past7.models.some((row) => row.model === "gpt-5.4")).toBe(false);
  });

  it("keeps zero-usage rows out of per-session window rows", async () => {
    const copilotHome = createCopilotHome();
    writeEvents(copilotHome, "resumed-session", [
      multiModelShutdown(localIso(2026, 0, 10), { old: 900, current: 0 }),
      multiModelShutdown(localIso(2026, 4, 12), { old: 900, current: 400 }),
    ]);

    const past7 = await readCopilotUsageSummary({ copilotHome, now, range: "7d" });
    const session = past7.sessions.find((row) => row.sessionId === "resumed-session");
    expect(session?.totalTokens).toBe(400);
    expect(session?.models.map((row) => row.model)).toEqual(["claude-opus-5"]);
  });
});
