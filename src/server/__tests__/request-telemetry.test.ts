import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, setupTestDb } from "./helpers.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createRequestTelemetryMiddleware } from "../api-request-telemetry.js";
import type { DatabaseSync } from "../db.js";
import type { TelemetryStore } from "../telemetry-store.js";

let db: DatabaseSync;
let store: TelemetryStore;

beforeEach(() => {
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
