import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CopilotUsageReadError,
  createCopilotUsageReader,
  readCopilotUsageSummary,
  type CopilotUsageSummary,
} from "../copilot-usage.js";
import { makeTestDir } from "./helpers.js";

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

    expect(summary).toEqual({
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
    expect(summary.totals).toEqual({
      requests: 2,
      inputTokens: 0,
      outputTokens: 17,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 17,
    });
    expect(summary.models).toEqual([
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
    expect(summary.sessions).toEqual([
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

    expect(summary.totals).toEqual({
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

    expect(summary.totals).toEqual({
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
    expect(summary.models).toEqual([
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

    expect(summary.totals).toEqual({
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

    expect(summary.totals).toEqual({
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

    expect(summary.totals).toEqual({
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

    expect(summary.totals).toEqual({
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
      totals: {
        requests: 1,
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 10,
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
        earliestIncludedAt: "2026-05-02T00:00:00.000Z",
        latestIncludedAt: "2026-05-02T00:00:00.000Z",
        earliestSkippedAt: null,
        latestSkippedAt: null,
      },
      models: [],
      sessions: [],
    };
    const refreshedSummary: CopilotUsageSummary = {
      ...staleSummary,
      generatedAt: "2026-05-02T00:00:02.000Z",
      totals: { ...staleSummary.totals, requests: 2, inputTokens: 20, totalTokens: 20 },
    };

    pending[1].resolve(refreshedSummary);
    await expect(refreshedPromise).resolves.toBe(refreshedSummary);

    pending[0].resolve(staleSummary);
    await expect(stalePromise).resolves.toBe(staleSummary);

    currentTime += 1_000;
    await expect(reader.readSummary()).resolves.toBe(refreshedSummary);
  });
});
