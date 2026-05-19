import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, setupTestDb } from "./helpers.js";
import { createTelemetryStore } from "../telemetry-store.js";
import {
  clearRequestTelemetryForTests,
  createRequestTelemetryMiddleware,
  getActiveRequestTelemetrySnapshots,
  getEventLoopLagRequestTelemetryMetadata,
  getRecentCompletedRequestOperations,
  recordInflightRequestTelemetry,
  timeRequestOperation,
  timeSyncRequestOperation,
} from "../api-request-telemetry.js";
import type { DatabaseSync } from "../db.js";
import type { TelemetryStore } from "../telemetry-store.js";

let db: DatabaseSync;
let store: TelemetryStore;

beforeEach(() => {
  clearRequestTelemetryForTests();
  db = setupTestDb();
  store = createTelemetryStore(db);
});

function createMockRequest(
  url: string,
  headers: Record<string, string | string[] | undefined> = {},
): any {
  return {
    method: "GET",
    url,
    originalUrl: url,
    headers,
  };
}

function createMockResponse(): any {
  const headers = new Map<string, string>();
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headersSent: boolean;
    locals: Record<string, unknown>;
    setHeader: (name: string, value: string) => void;
    getHeader: (name: string) => string | undefined;
  };

  res.statusCode = 200;
  res.headersSent = false;
  res.locals = {};
  res.setHeader = (name: string, value: string) => {
    headers.set(name.toLowerCase(), value);
  };
  res.getHeader = (name: string) => headers.get(name.toLowerCase());

  return res;
}

describe("request telemetry middleware", () => {
  it("reuses incoming request ids and logs 5xx responses", () => {
    let currentTime = 1_000;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      requestIdFactory: () => "generated-id",
    });
    const req = createMockRequest("/api/tasks?includeArchived=true", { "x-request-id": "upstream-id" });
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.getHeader("x-request-id")).toBe("upstream-id");

    res.statusCode = 503;
    currentTime = 1_480;
    res.emit("finish");

    const spans = store.querySpans({ name: "http.request.failed" });
    expect(spans).toHaveLength(1);
    expect(spans[0].duration).toBe(480);
    expect(spans[0].metadata).toMatchObject({
      requestId: "upstream-id",
      method: "GET",
      path: "/api/tasks",
      statusCode: 503,
    });
  });

  it("logs slow successful requests above the threshold", () => {
    let currentTime = 10;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      slowRequestMs: 100,
      requestIdFactory: () => "slow-id",
    });
    const req = createMockRequest("/api/dashboard");
    const res = createMockResponse();

    middleware(req, res, vi.fn());
    currentTime = 150;
    res.emit("finish");

    const spans = store.querySpans({ name: "http.request.slow" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      requestId: "slow-id",
      path: "/api/dashboard",
      statusCode: 200,
    });
  });

  it("logs closes before finish as aborted requests", () => {
    let currentTime = 100;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      requestIdFactory: () => "aborted-id",
    });
    const req = createMockRequest("/api/task-groups");
    const res = createMockResponse();

    middleware(req, res, vi.fn());
    currentTime = 140;
    res.emit("close");

    const spans = store.querySpans({ name: "http.request.aborted" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      requestId: "aborted-id",
      path: "/api/task-groups",
      statusCode: 200,
    });
    expect(getActiveRequestTelemetrySnapshots({ now: () => currentTime })).toEqual([]);
  });

  it("records request operations and exposes the current operation while in flight", async () => {
    let currentTime = 1_000;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      requestIdFactory: () => "operation-id",
    });
    const req = createMockRequest("/api/sessions?includeArchived=true");
    const res = createMockResponse();
    let release!: () => void;

    middleware(req, res, vi.fn());
    const operation = timeRequestOperation(
      res,
      "sessions.enrichedList",
      () => new Promise<string>((resolve) => {
        release = () => resolve("ok");
      }),
      { includeArchived: true },
    );

    currentTime = 1_300;
    expect(getActiveRequestTelemetrySnapshots({ now: () => currentTime })).toMatchObject([{
      requestId: "operation-id",
      method: "GET",
      path: "/api/sessions",
      ageMs: 300,
      currentOperation: {
        name: "sessions.enrichedList",
        ageMs: 300,
        metadata: { includeArchived: true },
      },
    }]);

    currentTime = 1_750;
    release();
    await expect(operation).resolves.toBe("ok");
    res.emit("finish");

    const spans = store.querySpans({ name: "http.request.operation" });
    expect(spans).toHaveLength(1);
    expect(spans[0].duration).toBe(750);
    expect(spans[0].metadata).toMatchObject({
      requestId: "operation-id",
      path: "/api/sessions",
      operation: "sessions.enrichedList",
      includeArchived: true,
      durationMs: 750,
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(1_750).toISOString(),
      startedAtMs: 1_000,
      endedAtMs: 1_750,
      statusCode: 200,
    });
    expect(getActiveRequestTelemetrySnapshots({ now: () => currentTime })).toEqual([]);
  });

  it("reports completed sync operations that overlapped an event-loop lag window", () => {
    let currentTime = 1_000;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      requestIdFactory: () => "lagged-id",
    });
    const req = createMockRequest("/api/chat");
    const res = createMockResponse();

    middleware(req, res, vi.fn());
    timeSyncRequestOperation(
      res,
      "chat.startWork",
      () => {
        currentTime = 7_600;
        return "accepted";
      },
      { sessionId: "session-1" },
    );
    res.emit("finish");

    expect(getActiveRequestTelemetrySnapshots({ now: () => currentTime })).toEqual([]);

    currentTime = 7_800;
    const metadata = getEventLoopLagRequestTelemetryMetadata(6_751, { now: () => currentTime });

    expect(metadata).toMatchObject({
      activeRequestCount: 0,
      activeRequests: [],
      lagWindowStart: new Date(1_049).toISOString(),
      lagWindowEnd: new Date(7_800).toISOString(),
    });
    expect(metadata.recentCompletedOperations).toMatchObject([{
      requestId: "lagged-id",
      method: "GET",
      path: "/api/chat",
      operation: "chat.startWork",
      durationMs: 6_600,
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(7_600).toISOString(),
      statusCode: 200,
      headersSent: false,
      threw: false,
      sessionId: "session-1",
    }]);
    expect(metadata).toHaveProperty("rssBytes");
    expect(metadata).toHaveProperty("activeResourceCount");
  });

  it("keeps the recent completed operation buffer bounded", () => {
    let currentTime = 10_000;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      requestIdFactory: () => `ring-id-${currentTime}`,
    });

    for (let index = 0; index < 205; index += 1) {
      const req = createMockRequest(`/api/tasks/${index}`);
      const res = createMockResponse();
      middleware(req, res, vi.fn());
      timeSyncRequestOperation(res, `ring.operation.${index}`, () => {
        currentTime += 1;
      });
      res.emit("finish");
    }

    const operations = getRecentCompletedRequestOperations({ limit: 500 });
    expect(operations).toHaveLength(200);
    expect(operations.map((operation) => operation.operation)).not.toContain("ring.operation.0");
    expect(operations.map((operation) => operation.operation)).toContain("ring.operation.204");
  });

  it("records repeated in-flight spans for slow unfinished requests", async () => {
    let currentTime = 0;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      requestIdFactory: () => "inflight-id",
    });
    const req = createMockRequest("/api/copilot-usage");
    const res = createMockResponse();
    let release!: () => void;

    middleware(req, res, vi.fn());
    const operation = timeRequestOperation(
      res,
      "copilot-usage.readSummary",
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    currentTime = 4_999;
    expect(recordInflightRequestTelemetry(store, {
      now: () => currentTime,
      thresholdMs: 5_000,
      repeatMs: 5_000,
    })).toBe(0);

    currentTime = 5_000;
    expect(recordInflightRequestTelemetry(store, {
      now: () => currentTime,
      thresholdMs: 5_000,
      repeatMs: 5_000,
    })).toBe(1);
    currentTime = 7_000;
    expect(recordInflightRequestTelemetry(store, {
      now: () => currentTime,
      thresholdMs: 5_000,
      repeatMs: 5_000,
    })).toBe(0);
    currentTime = 10_000;
    expect(recordInflightRequestTelemetry(store, {
      now: () => currentTime,
      thresholdMs: 5_000,
      repeatMs: 5_000,
    })).toBe(1);

    const spans = store.querySpans({ name: "http.request.inflight" })
      .sort((left, right) => left.duration - right.duration);
    expect(spans).toHaveLength(2);
    expect(spans[0].metadata).toMatchObject({
      requestId: "inflight-id",
      path: "/api/copilot-usage",
      requestAgeMs: 5_000,
      currentOperation: { name: "copilot-usage.readSummary", ageMs: 5_000 },
      inflightReportCount: 1,
      activeRequestCount: 1,
    });
    expect(spans[1].metadata).toMatchObject({
      requestAgeMs: 10_000,
      inflightReportCount: 2,
    });

    release();
    await operation;
    res.emit("finish");
    expect(getActiveRequestTelemetrySnapshots({ now: () => currentTime })).toEqual([]);
  });

  it("reports in-flight request metadata even without an active operation wrapper", () => {
    let currentTime = 0;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      requestIdFactory: () => "plain-inflight-id",
    });
    const req = createMockRequest("/api/busy");
    const res = createMockResponse();

    middleware(req, res, vi.fn());

    currentTime = 5_000;
    expect(recordInflightRequestTelemetry(store, {
      now: () => currentTime,
      thresholdMs: 5_000,
      repeatMs: 5_000,
    })).toBe(1);

    const spans = store.querySpans({ name: "http.request.inflight" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      requestId: "plain-inflight-id",
      method: "GET",
      path: "/api/busy",
      requestAgeMs: 5_000,
      operationDepth: 0,
      activeRequestCount: 1,
    });
    expect(spans[0].metadata).not.toHaveProperty("currentOperation");

    res.emit("finish");
    expect(getActiveRequestTelemetrySnapshots({ now: () => currentTime })).toEqual([]);
  });

  it("does not record completed operations for cheap API route work", async () => {
    const { app } = createTestApp();

    await request(app).get("/api/sessions?includeArchived=true").expect(200);
    await request(app).get("/api/busy").expect(200);
    await request(app).get("/api/copilot-usage").expect(200);
    await request(app).get("/api/sessions/session-1/messages-fast").expect(200);
    await request(app).get("/api/read-state").expect(200);
    await request(app).post("/api/read-state/session-1").expect(200);
    await request(app).delete("/api/read-state/session-1").expect(200);

    const operationNames = getRecentCompletedRequestOperations({ limit: 50 })
      .map((operation) => operation.operation);
    expect(operationNames).toContain("sessions.enrichedList");
    expect(operationNames).toContain("copilot-usage.readSummary");
    expect(operationNames).toContain("sessions.messagesFast.diskRead");
    for (const removedOperation of [
      "sessions.materialize",
      "busy.sessionActivity",
      "copilot-usage.serialize",
      "sessions.messagesFast.status",
      "sessions.messagesFast.warmState",
      "read-state.get",
      "read-state.resolveActivity",
      "read-state.markRead",
      "read-state.emitChanged",
      "read-state.markUnread",
    ]) {
      expect(operationNames).not.toContain(removedOperation);
    }
  });

  it("skips telemetry and streaming endpoints to avoid noisy recursion", () => {
    let currentTime = 0;
    const middleware = createRequestTelemetryMiddleware(store, {
      now: () => currentTime,
      slowRequestMs: 1,
      requestIdFactory: () => "ignored-id",
    });

    for (const url of ["/api/telemetry", "/api/status-stream", "/api/sessions/test-id/stream"]) {
      const req = createMockRequest(url);
      const res = createMockResponse();
      middleware(req, res, vi.fn());
      currentTime += 10;
      res.emit("finish");
      res.emit("close");
    }

    expect(store.querySpans()).toHaveLength(0);
  });

  it("captures invalid JSON requests once the middleware runs before body parsing", async () => {
    const { app, ctx } = createTestApp();

    const res = await request(app)
      .post("/api/tasks")
      .set("Content-Type", "application/json")
      .send("{");

    expect(res.status).toBe(400);
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.body).toEqual({ error: "Malformed JSON request body" });

    const spans = ctx.telemetryStore!.querySpans({ name: "http.request.failed" });
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      method: "POST",
      path: "/api/tasks",
      statusCode: 400,
      parseError: true,
    });
  });
});
