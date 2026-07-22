import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIncrementalCopilotUsageReader } from "../copilot-usage-index.js";
import {
  scanCopilotUsageSession,
  type CopilotUsageReader,
  type CopilotUsageSummary,
} from "../copilot-usage.js";
import { createCopilotUsageStore } from "../copilot-usage-store.js";
import { openMemoryDatabase } from "../db.js";
import { makeTestDir } from "./helpers.js";

function createCopilotHome(): string {
  return makeTestDir("copilot-usage-index");
}

function writeUsage(copilotHome: string, sessionId: string, inputTokens: number): void {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "events.jsonl"), `${JSON.stringify({
    type: "session.shutdown",
    timestamp: "2026-07-15T12:00:00.000Z",
    data: {
      modelMetrics: {
        "gpt-5.4": {
          requests: { count: 1 },
          usage: { inputTokens },
        },
      },
    },
  })}\n`);
}

async function waitForSummary(
  reader: CopilotUsageReader,
  predicate: (summary: CopilotUsageSummary) => boolean,
  options?: { sessionIds?: readonly string[] },
): Promise<CopilotUsageSummary> {
  let latest: CopilotUsageSummary | undefined;
  await vi.waitFor(async () => {
    latest = await reader.readSummary(options);
    expect(predicate(latest)).toBe(true);
  }, { timeout: 5_000 });
  return latest!;
}

describe("createIncrementalCopilotUsageReader", () => {
  it("returns immediately with indexing status and publishes results progressively", async () => {
    const db = openMemoryDatabase();
    const copilotHome = createCopilotHome();
    writeUsage(copilotHome, "session-1", 10);
    const reader = createIncrementalCopilotUsageReader({
      copilotHome,
      store: createCopilotUsageStore(db),
      refreshIntervalMs: 60_000,
      batchSize: 1,
      concurrency: 1,
    });

    const initial = await reader.readSummary();
    expect(initial.index?.state).toBe("scanning");
    expect(initial.totals.inputTokens).toBe(0);

    const complete = await waitForSummary(reader, (summary) => summary.index?.state === "idle");
    expect(complete.totals.inputTokens).toBe(10);
    expect(complete.index).toMatchObject({
      sessionsTotal: 1,
      sessionsProcessed: 1,
      sessionsUpdated: 1,
      cachedSessions: 1,
    });

    db.close();
  });

  it("reuses persisted results across readers and only reparses changed files", async () => {
    const db = openMemoryDatabase();
    const copilotHome = createCopilotHome();
    writeUsage(copilotHome, "session-1", 10);
    const store = createCopilotUsageStore(db);
    const firstScanner = vi.fn(scanCopilotUsageSession);
    const firstReader = createIncrementalCopilotUsageReader({
      copilotHome,
      store,
      scanSession: firstScanner,
      refreshIntervalMs: 60_000,
    });

    await firstReader.readSummary({ refresh: true });
    await waitForSummary(firstReader, (summary) => summary.index?.state === "idle");
    expect(firstScanner).toHaveBeenCalledTimes(1);

    const secondScanner = vi.fn(scanCopilotUsageSession);
    const secondReader = createIncrementalCopilotUsageReader({
      copilotHome,
      store,
      scanSession: secondScanner,
      refreshIntervalMs: 60_000,
    });
    const cached = await secondReader.readSummary({ refresh: true });
    expect(cached.totals.inputTokens).toBe(10);
    await waitForSummary(secondReader, (summary) => summary.index?.state === "idle");
    expect(secondScanner).not.toHaveBeenCalled();

    writeUsage(copilotHome, "session-1", 200);
    await secondReader.readSummary({ refresh: true });
    const refreshed = await waitForSummary(
      secondReader,
      (summary) => summary.index?.state === "idle" && summary.totals.inputTokens === 200,
    );
    expect(refreshed.totals.inputTokens).toBe(200);
    expect(secondScanner).toHaveBeenCalledTimes(1);

    db.close();
  });

  it("prioritizes requested task sessions and returns only requested session rows", async () => {
    const db = openMemoryDatabase();
    const copilotHome = createCopilotHome();
    writeUsage(copilotHome, "a-regular", 10);
    writeUsage(copilotHome, "z-priority", 20);
    const calls: string[] = [];
    const reader = createIncrementalCopilotUsageReader({
      copilotHome,
      store: createCopilotUsageStore(db),
      batchSize: 1,
      concurrency: 1,
      scanSession: async (sessionStateDir, sessionId) => {
        calls.push(sessionId);
        return scanCopilotUsageSession(sessionStateDir, sessionId);
      },
    });

    await reader.readSummary({ sessionIds: ["z-priority"] });
    const prioritized = await waitForSummary(
      reader,
      (summary) => summary.index?.requestedSessionsCached === 1,
      { sessionIds: ["z-priority"] },
    );

    expect(calls[0]).toBe("z-priority");
    expect(prioritized.sessions.map((row) => row.sessionId)).toEqual(["z-priority"]);
    await waitForSummary(reader, (summary) => summary.index?.state === "idle");
    db.close();
  });

  it("reparses unchanged files when the cached parser version is obsolete", async () => {
    const db = openMemoryDatabase();
    const copilotHome = createCopilotHome();
    writeUsage(copilotHome, "session-1", 10);
    writeUsage(copilotHome, "session-2", 20);
    const store = createCopilotUsageStore(db);
    const seedReader = createIncrementalCopilotUsageReader({ copilotHome, store });
    await seedReader.readSummary({ refresh: true });
    await waitForSummary(seedReader, (summary) => summary.index?.state === "idle");

    const [obsoleteEntry] = store.listEntries();
    store.upsertEntries([{ ...obsoleteEntry, parserVersion: 0 }]);
    const scanner = vi.fn(scanCopilotUsageSession);
    const reader = createIncrementalCopilotUsageReader({
      copilotHome,
      store,
      scanSession: scanner,
    });

    const initial = await reader.readSummary();
    expect(initial.index?.state).toBe("scanning");
    expect(initial.totals.inputTokens).toBe(20);
    const refreshed = await waitForSummary(reader, (summary) => summary.index?.state === "idle");
    expect(refreshed.totals.inputTokens).toBe(30);
    expect(scanner).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("bypasses the refresh throttle for explicitly requested uncached sessions", async () => {
    const db = openMemoryDatabase();
    const copilotHome = createCopilotHome();
    writeUsage(copilotHome, "cached-session", 10);
    const store = createCopilotUsageStore(db);
    const seedReader = createIncrementalCopilotUsageReader({ copilotHome, store });
    await seedReader.readSummary({ refresh: true });
    await waitForSummary(seedReader, (summary) => summary.index?.state === "idle");

    writeUsage(copilotHome, "new-task-session", 20);
    const scanner = vi.fn(scanCopilotUsageSession);
    const reader = createIncrementalCopilotUsageReader({
      copilotHome,
      store,
      scanSession: scanner,
      refreshIntervalMs: 60_000,
    });

    const initial = await reader.readSummary({ sessionIds: ["new-task-session"] });
    expect(initial.index?.state).toBe("scanning");
    const refreshed = await waitForSummary(
      reader,
      (summary) => summary.index?.requestedSessionsCached === 1,
      { sessionIds: ["new-task-session"] },
    );
    expect(refreshed.sessions.map((row) => row.sessionId)).toEqual(["new-task-session"]);
    expect(scanner).toHaveBeenCalledWith(expect.any(String), "new-task-session");
    await waitForSummary(reader, (summary) => summary.index?.state === "idle");
    db.close();
  });

  it("does not repeatedly rescan for requested sessions that are absent on disk", async () => {
    const db = openMemoryDatabase();
    const reader = createIncrementalCopilotUsageReader({
      copilotHome: createCopilotHome(),
      store: createCopilotUsageStore(db),
      refreshIntervalMs: 60_000,
    });

    const initial = await reader.readSummary({ sessionIds: ["missing-session"] });
    expect(initial.index?.state).toBe("scanning");
    const complete = await waitForSummary(
      reader,
      (summary) => summary.index?.state === "idle",
      { sessionIds: ["missing-session"] },
    );
    expect(complete.index).toMatchObject({
      requestedSessions: 1,
      requestedSessionsCached: 0,
    });

    const repeated = await reader.readSummary({ sessionIds: ["missing-session"] });
    expect(repeated.index?.state).toBe("idle");
    db.close();
  });

  it("keeps the last good cache when a changed session fails to scan", async () => {
    const db = openMemoryDatabase();
    const copilotHome = createCopilotHome();
    writeUsage(copilotHome, "session-1", 10);
    let fail = false;
    const reader = createIncrementalCopilotUsageReader({
      copilotHome,
      store: createCopilotUsageStore(db),
      scanSession: async (sessionStateDir, sessionId) => {
        if (fail) throw new Error("scan failed");
        return scanCopilotUsageSession(sessionStateDir, sessionId);
      },
    });

    await reader.readSummary({ refresh: true });
    await waitForSummary(reader, (summary) => summary.index?.state === "idle");
    fail = true;
    writeUsage(copilotHome, "session-1", 200);
    await reader.readSummary({ refresh: true });

    const failed = await waitForSummary(reader, (summary) => summary.index?.state === "error");
    expect(failed.totals.inputTokens).toBe(10);
    expect(failed.index?.error).toContain("Cached results");
    db.close();
  });

  it("drains an active scan during shutdown and prevents later refreshes", async () => {
    const db = openMemoryDatabase();
    const copilotHome = createCopilotHome();
    writeUsage(copilotHome, "session-1", 10);
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanner = vi.fn(async (sessionStateDir: string, sessionId: string) => {
      await scanGate;
      return scanCopilotUsageSession(sessionStateDir, sessionId);
    });
    const reader = createIncrementalCopilotUsageReader({
      copilotHome,
      store: createCopilotUsageStore(db),
      scanSession: scanner,
    });

    await reader.readSummary({ refresh: true });
    await vi.waitFor(() => expect(scanner).toHaveBeenCalledTimes(1));
    let shutdownComplete = false;
    const shutdown = reader.shutdown().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    releaseScan();
    await shutdown;
    expect(shutdownComplete).toBe(true);

    await reader.readSummary({ refresh: true });
    expect(scanner).toHaveBeenCalledTimes(1);
    db.close();
  });
});
