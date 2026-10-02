import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBackendLossRecorder,
  keepRuntimeLogLine,
  readRuntimeLogExcerpt,
  type BackendLossRecord,
} from "../backend-loss-record.js";
import { makeTestDir } from "./helpers.js";

const LOSS_AT = "2026-09-21T07:14:35.410Z";
const LOSS_AT_MS = Date.parse(LOSS_AT);
const RUNTIME_STARTED_AT_MS = Date.parse("2026-09-21T05:53:35.099Z");
const RUNTIME_PID = 4243;
const STUCK = "7be44011-ce73-4eee-90a7-a6b93f58184b";
const BUSY = "22222222-2222-4222-8222-222222222222";

const delivery = (at: string, eventType: string) =>
  `${at} [DEBUG] [rust:copilot_runtime::session::pending_request_flow] Detached host delivery started `
  + `{"delivery_session_id":"${BUSY}","queue_id":1,"delivery_kind":"reserved_event","event_type":"${eventType}","event_id":"e"}`;

const PREVIOUS_FILE = [
  `2026-09-21T07:10:00.000Z [INFO] Resumed session: ${BUSY}`,
  "2026-09-21T07:12:00.000Z [DEBUG] [rust:model_wire] Wire request: {",
  '  "messages": [{ "role": "user", "content": "secret prompt text" }]',
  "}",
  '2026-09-21T07:12:10.000Z [DEBUG] Received session.resume request: {"systemMessage":"private instructions"}',
  "2026-09-21T07:12:20.000Z [WARNING] [rust:session_bindings::api_session_event_stream] Session event stream lagged; "
    + 'recovering from the registry snapshot {"skipped":5}',
  delivery("2026-09-21T07:12:30.000Z", "assistant.turn_start"),
];

const CURRENT_FILE = [
  `2026-09-21T07:13:35.392Z [INFO] Cleaning up session ${STUCK}: Session closed after last owner detached`,
  `2026-09-21T07:13:35.393Z [DEBUG] Cleaned up event forwarding for session ${STUCK}`,
  '2026-09-21T07:13:36.000Z [DEBUG] [rust:log] processing CharacterTokens(NotSplit, Tendril<UTF8>(inline: "page text"))',
  "2026-09-21T07:13:40.000Z [INFO] [rust:copilot_runtime::session::session_notification_delivery] "
    + 'Shell command "deploy the thing" completed',
  delivery("2026-09-21T07:14:01.854Z", "tool.execution_complete"),
  "2026-09-21T07:14:02.000Z [ERROR] [rust:copilot_runtime::shared_api::lifecycle] Scheduled queue processing failed; "
    + `retrying once {"error":"${"x".repeat(400)}"}`,
  `2026-09-21T07:14:36.000Z [DEBUG] [close] ${STUCK} done at=12ms`,
];

function writeLog(logsDir: string, name: string, lines: string[], modifiedAt: string): void {
  const path = join(logsDir, name);
  writeFileSync(path, `${lines.join("\r\n")}\r\n`);
  utimesSync(path, new Date(modifiedAt), new Date(modifiedAt));
}

function makeLogsDir(): string {
  const logsDir = join(makeTestDir("backend-loss-logs"), "logs");
  mkdirSync(logsDir);
  writeLog(logsDir, `process-${RUNTIME_STARTED_AT_MS}-${RUNTIME_PID}.1.log`, PREVIOUS_FILE, "2026-09-21T07:12:59.000Z");
  writeLog(logsDir, `process-${RUNTIME_STARTED_AT_MS}-${RUNTIME_PID}.log`, CURRENT_FILE, "2026-09-21T07:14:36.000Z");
  // An earlier runtime that had the same pid, and an unrelated one.
  writeLog(logsDir, `process-${RUNTIME_STARTED_AT_MS - 86_400_000}-${RUNTIME_PID}.log`,
    ["2026-09-20T07:14:00.000Z [WARNING] yesterday's runtime"], "2026-09-20T07:14:00.000Z");
  writeLog(logsDir, `process-${RUNTIME_STARTED_AT_MS - 5_000}-9999.log`,
    ["2026-09-21T07:14:00.000Z [WARNING] another runtime"], "2026-09-21T07:14:00.000Z");
  return logsDir;
}

function makeRecord(overrides: Partial<BackendLossRecord> = {}): BackendLossRecord {
  return {
    version: 1,
    at: LOSS_AT,
    reason: "cleanup-stalled",
    origin: "bridge",
    summary: "Bridge restarted the agent backend.",
    trigger: null,
    server: { pid: 1, startedAt: LOSS_AT, uptimeMs: 0 },
    backend: { generation: 1, startedAt: null, uptimeMs: null, connection: "connected", pid: 4242, runtimePids: [] },
    host: { lastResumeAt: null, msSinceResume: null, sleptMs: null },
    lastRuntimeEvent: null,
    interruptedRuns: [],
    cachedSessions: [],
    pendingReleases: [],
    ping: null,
    runtimeKilledAfterMs: null,
    recovery: null,
    runtimeLog: null,
    ...overrides,
  };
}

describe("runtime log line selection", () => {
  it.each([
    ["WARNING", "[shutdown] session-store tracking flush for abc did not finish within 1000ms; continuing without it"],
    ["ERROR", "[rust:copilot_runtime::shared_api::lifecycle] Scheduled queue processing failed; retrying once"],
    ["INFO", "Closing session abc"],
    ["DEBUG", "[close] abc releaseSessionLock at=1301ms"],
    ["INFO", '[rust:rmcp::service] serve finished {"quit_reason":"Closed"}'],
    ["DEBUG", '[rust:copilot_runtime::session::services] session services shutdown stage {"stage":"canvas","elapsed_ms":0}'],
  ])("keeps %s %s", (level, body) => {
    expect(keepRuntimeLogLine(level, body)).toBe(true);
  });

  it.each([
    ["DEBUG", "[rust:model_wire] Wire request: {"],
    ["WARNING", "[rust:model_wire] response truncated"],
    ["DEBUG", '[rust:log] processing CharacterTokens(NotSplit, Tendril<UTF8>(inline: "page text"))'],
    ["DEBUG", 'Received session.create request: {"systemMessage":"private"}'],
    ["INFO", '[rust:copilot_runtime::session::session_notification_delivery] Shell command "deploy" completed'],
    ["INFO", '[rust:rmcp::service] Service initialized as client {"instructions":"private"}'],
    ["DEBUG", '[ContentExclusionService] No cached rules for urls=["https://example.test/private"]'],
  ])("drops %s %s", (level, body) => {
    expect(keepRuntimeLogLine(level, body)).toBe(false);
  });
});

describe("readRuntimeLogExcerpt", () => {
  it("reads the lost runtime's last minutes across rotated files without copying payloads", async () => {
    const excerpt = await readRuntimeLogExcerpt({
      logsDir: makeLogsDir(), pids: [4242, RUNTIME_PID], backendStartedAtMs: null, lossAtMs: LOSS_AT_MS,
    });

    expect(excerpt).toMatchObject({
      status: "read",
      matchedBy: "pid",
      files: [`process-${RUNTIME_STARTED_AT_MS}-${RUNTIME_PID}.log`, `process-${RUNTIME_STARTED_AT_MS}-${RUNTIME_PID}.1.log`],
      windowSeconds: 180,
      reachesWindowStart: true,
      lastLineAt: "2026-09-21T07:14:36.000Z",
      eventDeliveries: [
        { sessionId: BUSY, count: 2, lastAt: "2026-09-21T07:14:01.854Z", lastEventType: "tool.execution_complete" },
      ],
      earlierLinesOmitted: 0,
    });
    if (excerpt.status !== "read") throw new Error("unreachable");
    expect(excerpt.lines.map((line) => line.slice(0, 60))).toEqual([
      "2026-09-21T07:12:20.000Z [WARNING] [rust:session_bindings::a",
      "2026-09-21T07:13:35.392Z [INFO] Cleaning up session 7be44011",
      "2026-09-21T07:13:35.393Z [DEBUG] Cleaned up event forwarding",
      "2026-09-21T07:14:02.000Z [ERROR] [rust:copilot_runtime::shar",
      "2026-09-21T07:14:36.000Z [DEBUG] [close] 7be44011-ce73-4eee-",
    ]);
    expect(excerpt.lines[3]).toHaveLength(301);
    expect(excerpt.lines[3]!.endsWith("…")).toBe(true);
    expect(JSON.stringify(excerpt)).not.toMatch(/secret prompt|private instructions|page text|deploy the thing|yesterday|another runtime/);
  });

  it("falls back to the log that started just before the backend was ready", async () => {
    const logsDir = makeLogsDir();
    const excerpt = await readRuntimeLogExcerpt({
      logsDir, pids: [], backendStartedAtMs: RUNTIME_STARTED_AT_MS + 900, lossAtMs: LOSS_AT_MS,
    });
    expect(excerpt).toMatchObject({ status: "read", matchedBy: "start-time" });
    if (excerpt.status !== "read") throw new Error("unreachable");
    expect(excerpt.files[0]).toBe(`process-${RUNTIME_STARTED_AT_MS}-${RUNTIME_PID}.log`);

    await expect(readRuntimeLogExcerpt({ logsDir, pids: [1], backendStartedAtMs: null, lossAtMs: LOSS_AT_MS }))
      .resolves.toEqual({ status: "unavailable", reason: "no runtime log matches the lost backend" });
    await expect(readRuntimeLogExcerpt({
      logsDir: join(logsDir, "missing"), pids: [RUNTIME_PID], backendStartedAtMs: null, lossAtMs: LOSS_AT_MS,
    })).resolves.toEqual({ status: "unavailable", reason: "ENOENT" });
  });

  it("keeps the newest lines and says when the window is not covered", async () => {
    const logsDir = join(makeTestDir("backend-loss-busy-log"), "logs");
    mkdirSync(logsDir);
    const lines = Array.from({ length: 450 }, (_, index) =>
      `${new Date(LOSS_AT_MS - 60_000 + index * 100).toISOString()} [WARNING] warning ${index}`);
    writeLog(logsDir, `process-${RUNTIME_STARTED_AT_MS}-${RUNTIME_PID}.log`, lines, LOSS_AT);

    const excerpt = await readRuntimeLogExcerpt({
      logsDir, pids: [RUNTIME_PID], backendStartedAtMs: null, lossAtMs: LOSS_AT_MS,
    });
    expect(excerpt).toMatchObject({ status: "read", reachesWindowStart: false, earlierLinesOmitted: 50, eventDeliveries: [] });
    if (excerpt.status !== "read") throw new Error("unreachable");
    expect(excerpt.lines).toHaveLength(400);
    expect(excerpt.lines[0]!.endsWith("warning 50")).toBe(true);
    expect(excerpt.lines[399]!.endsWith("warning 449")).toBe(true);
  });

  it("treats a runtime younger than the window as covered from its first line", async () => {
    const logsDir = join(makeTestDir("backend-loss-young-log"), "logs");
    mkdirSync(logsDir);
    const startedAtMs = LOSS_AT_MS - 20_000;
    writeLog(logsDir, `process-${startedAtMs}-${RUNTIME_PID}.log`,
      [`${new Date(startedAtMs + 400).toISOString()} [INFO] Created session: ${BUSY}`], LOSS_AT);

    await expect(readRuntimeLogExcerpt({
      logsDir, pids: [RUNTIME_PID], backendStartedAtMs: null, lossAtMs: LOSS_AT_MS,
    })).resolves.toMatchObject({ status: "read", reachesWindowStart: true, lines: [expect.stringContaining("Created session")] });
  });
});

describe("createBackendLossRecorder", () => {
  it("writes the record at once and rewrites it as more becomes known", async () => {
    const directory = join(makeTestDir("backend-loss-records"), "backend-losses");
    const handle = createBackendLossRecorder({ directory }).open(makeRecord());
    expect(handle.fileName).toBe("2026-09-21T07-14-35-410Z-cleanup-stalled.json");
    await handle.flushed();
    const path = join(directory, handle.fileName);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ reason: "cleanup-stalled", ping: null, recovery: null });

    handle.update({ ping: { outcome: "responsive", elapsedMs: 4 } });
    handle.update({ recovery: { outcome: "recovered", durationMs: 5_560 } });
    await handle.flushed();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      summary: "Bridge restarted the agent backend.",
      ping: { outcome: "responsive", elapsedMs: 4 },
      recovery: { outcome: "recovered", durationMs: 5_560 },
    });
    expect(readdirSync(directory)).toEqual([handle.fileName]);
  });

  it("keeps only the newest records", async () => {
    const directory = join(makeTestDir("backend-loss-retention"), "backend-losses");
    mkdirSync(directory);
    const dayMs = 24 * 60 * 60_000;
    for (const daysAgo of [3, 2, 1]) {
      const path = join(directory, `${daysAgo}-days-ago.json`);
      writeFileSync(path, "{}\n");
      utimesSync(path, new Date(Date.now() - daysAgo * dayMs), new Date(Date.now() - daysAgo * dayMs));
    }
    const handle = createBackendLossRecorder({ directory, maxRecords: 2 }).open(makeRecord());
    await handle.flushed();
    expect(readdirSync(directory).sort()).toEqual(["1-days-ago.json", handle.fileName]);
  });

  it("reports a failed write once and never throws", async () => {
    const blocked = join(makeTestDir("backend-loss-blocked"), "not-a-directory");
    writeFileSync(blocked, "");
    const logger = { warn: vi.fn() };
    const handle = createBackendLossRecorder({ directory: blocked, logger }).open(makeRecord());
    handle.update({ runtimeKilledAfterMs: 590 });
    await expect(handle.flushed()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]![0]).toContain("[backend-loss] Could not write");
  });

  it("keeps the last good file when an update cannot be serialized", async () => {
    const directory = join(makeTestDir("backend-loss-unserializable"), "backend-losses");
    const logger = { warn: vi.fn() };
    const handle = createBackendLossRecorder({ directory, logger }).open(makeRecord());
    await handle.flushed();
    handle.update({ runtimeKilledAfterMs: 590n as unknown as number });
    await expect(handle.flushed()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(directory, handle.fileName), "utf8"))).toMatchObject({
      reason: "cleanup-stalled",
      runtimeKilledAfterMs: null,
    });
  });
});
