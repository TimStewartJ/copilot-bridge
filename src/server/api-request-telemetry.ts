import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import type { TelemetryStore } from "./telemetry-store.js";

const DEFAULT_SLOW_REQUEST_MS = 1_500;
const DEFAULT_REQUEST_OPERATION_SPAN_MS = 25;
const RECENT_COMPLETED_OPERATION_LIMIT = 200;
const DEFAULT_INFLIGHT_REQUEST_MS = 5_000;
const DEFAULT_INFLIGHT_REPEAT_MS = 5_000;
const DEFAULT_INFLIGHT_INTERVAL_MS = 2_000;
const DEFAULT_INFLIGHT_MAX_REPORTS = 24;
const LARGE_EVENT_LOOP_LAG_MS = 1_000;
const API_SUBPATH_RE = /^(?:\/staging\/[^/]+)?\/api(?<subpath>\/.*)?$/;
const SESSION_STREAM_SUBPATH_RE = /^\/sessions\/[^/]+\/stream$/;
const REQUEST_TELEMETRY_KEY = "__requestTelemetry";

type RequestMetadataBase = {
  requestId: string;
  method: string;
  path: string;
  requestContentLength?: string;
  userAgent?: string;
};

type ActiveRequestOperation = {
  name: string;
  startedAt: number;
  metadata?: Record<string, unknown>;
};

type ActiveRequestTelemetryEntry = {
  key: string;
  startedAt: number;
  metadataBase: RequestMetadataBase;
  getStatusCode: () => number;
  getHeadersSent: () => boolean;
  operationStack: ActiveRequestOperation[];
  inflightReportCount: number;
  lastInflightReportAt?: number;
};

type RequestTelemetryContext = {
  startedAt: number;
  shouldTrack: boolean;
  metadataBase: RequestMetadataBase;
  now: () => number;
  telemetryStore?: TelemetryStore;
  activeEntry?: ActiveRequestTelemetryEntry;
  failureLogged?: boolean;
};

export interface RequestTelemetryOptions {
  slowRequestMs?: number;
  now?: () => number;
  requestIdFactory?: () => string;
}

export interface ActiveRequestTelemetrySnapshot {
  requestId: string;
  method: string;
  path: string;
  ageMs: number;
  startedAt: string;
  statusCode: number;
  headersSent: boolean;
  currentOperation?: {
    name: string;
    ageMs: number;
    startedAt: string;
    metadata?: Record<string, unknown>;
  };
  operationDepth: number;
}

export interface ActiveRequestTelemetrySnapshotOptions {
  limit?: number;
  now?: () => number;
}

export interface RequestTelemetryInflightReporterOptions {
  now?: () => number;
  thresholdMs?: number;
  repeatMs?: number;
  intervalMs?: number;
  snapshotLimit?: number;
  maxReports?: number;
}

export interface RequestTelemetryInflightReporter {
  stop(): void;
}

export interface RecentCompletedRequestOperation {
  requestId: string;
  method: string;
  path: string;
  operation: string;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  startedAtMs: number;
  endedAtMs: number;
  statusCode: number;
  headersSent: boolean;
  threw: boolean;
  sessionId?: string;
  taskId?: string;
}

export interface RecentCompletedRequestOperationOptions {
  limit?: number;
  windowStartMs?: number;
  windowEndMs?: number;
}

export interface EventLoopLagRequestTelemetryOptions {
  now?: () => number;
  activeRequestLimit?: number;
  completedOperationLimit?: number;
}

let activeRequestSequence = 0;
const activeRequestTelemetryEntries = new Map<string, ActiveRequestTelemetryEntry>();
const recentCompletedRequestOperations: RecentCompletedRequestOperation[] = [];

function stripQuery(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
}

function getApiSubpath(path: string): string | null {
  const match = path.match(API_SUBPATH_RE);
  if (!match) return null;
  return match.groups?.subpath ?? "/";
}

function getRequestId(
  incoming: string | string[] | undefined,
  createRequestId: () => string,
): string {
  if (typeof incoming === "string" && incoming.trim()) return incoming.trim();
  if (Array.isArray(incoming)) {
    const first = incoming.find((value) => value.trim());
    if (first) return first.trim();
  }
  return createRequestId();
}

function shouldSkipTelemetry(path: string): boolean {
  const apiSubpath = getApiSubpath(path);
  if (!apiSubpath) return false;

  return apiSubpath === "/status-stream"
    || SESSION_STREAM_SUBPATH_RE.test(apiSubpath)
    || apiSubpath === "/telemetry"
    || apiSubpath.startsWith("/telemetry/");
}

function headerToString(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value ? value : undefined;
}

function isTrackedParseError(err: unknown): err is Error & { status?: number; statusCode?: number; type?: string; expose?: boolean } {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { status?: number; statusCode?: number; type?: string; expose?: boolean };
  return candidate.type === "entity.parse.failed"
    || candidate.status === 400
    || candidate.statusCode === 400;
}

function getResponseContentLength(res: Parameters<NonNullable<TelemetryStore>["recordSpan"]>[0] extends never ? never : any): string | undefined {
  return headerToString(res.getHeader("content-length") as string | number | string[] | undefined);
}

function getContext(res: Response): RequestTelemetryContext | undefined {
  return (res.locals as Record<string, unknown>)[REQUEST_TELEMETRY_KEY] as RequestTelemetryContext | undefined;
}

function getCurrentOperation(entry: ActiveRequestTelemetryEntry): ActiveRequestOperation | undefined {
  return entry.operationStack[entry.operationStack.length - 1];
}

function toIsoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function toActiveRequestSnapshot(
  entry: ActiveRequestTelemetryEntry,
  nowMs: number,
): ActiveRequestTelemetrySnapshot {
  const operation = getCurrentOperation(entry);
  return {
    requestId: entry.metadataBase.requestId,
    method: entry.metadataBase.method,
    path: entry.metadataBase.path,
    ageMs: Math.max(0, nowMs - entry.startedAt),
    startedAt: toIsoTime(entry.startedAt),
    statusCode: entry.getStatusCode(),
    headersSent: entry.getHeadersSent(),
    ...(operation
      ? {
          currentOperation: {
            name: operation.name,
            ageMs: Math.max(0, nowMs - operation.startedAt),
            startedAt: toIsoTime(operation.startedAt),
            ...(operation.metadata ? { metadata: operation.metadata } : {}),
          },
        }
      : {}),
    operationDepth: entry.operationStack.length,
  };
}

export function getActiveRequestTelemetrySnapshots(
  options: ActiveRequestTelemetrySnapshotOptions = {},
): ActiveRequestTelemetrySnapshot[] {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const limit = Math.max(0, options.limit ?? 5);
  return [...activeRequestTelemetryEntries.values()]
    .map((entry) => toActiveRequestSnapshot(entry, nowMs))
    .sort((left, right) => right.ageMs - left.ageMs)
    .slice(0, limit);
}

export function getActiveRequestTelemetryCount(): number {
  return activeRequestTelemetryEntries.size;
}

export function getRequestTelemetryRuntimeMetadata(): Record<string, unknown> {
  const memory = process.memoryUsage();
  const activeResources = typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo()
    : [];
  return {
    pid: process.pid,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    activeResourceCount: activeResources.length,
    activeResourceTypes: [...new Set(activeResources)].sort().slice(0, 25),
  };
}

function getStringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

function rememberCompletedRequestOperation(record: RecentCompletedRequestOperation): void {
  recentCompletedRequestOperations.push(record);
  const overflow = recentCompletedRequestOperations.length - RECENT_COMPLETED_OPERATION_LIMIT;
  if (overflow > 0) recentCompletedRequestOperations.splice(0, overflow);
}

function buildCompletedRequestOperation(
  ctx: RequestTelemetryContext,
  res: Response,
  operation: string,
  startedAt: number,
  endedAt: number,
  metadata: Record<string, unknown>,
  didThrow: boolean,
): RecentCompletedRequestOperation {
  const durationMs = Math.max(0, endedAt - startedAt);
  return {
    requestId: ctx.metadataBase.requestId,
    method: ctx.metadataBase.method,
    path: ctx.metadataBase.path,
    operation,
    durationMs,
    startedAt: toIsoTime(startedAt),
    endedAt: toIsoTime(endedAt),
    startedAtMs: startedAt,
    endedAtMs: endedAt,
    statusCode: res.statusCode,
    headersSent: res.headersSent,
    threw: didThrow,
    ...(getStringMetadata(metadata, "sessionId") ? { sessionId: getStringMetadata(metadata, "sessionId") } : {}),
    ...(getStringMetadata(metadata, "taskId") ? { taskId: getStringMetadata(metadata, "taskId") } : {}),
  };
}

function windowsOverlap(
  leftStartMs: number,
  leftEndMs: number,
  rightStartMs: number,
  rightEndMs: number,
): boolean {
  return leftStartMs <= rightEndMs && leftEndMs >= rightStartMs;
}

export function getRecentCompletedRequestOperations(
  options: RecentCompletedRequestOperationOptions = {},
): RecentCompletedRequestOperation[] {
  const limit = Math.max(0, options.limit ?? 10);
  const windowStartMs = options.windowStartMs ?? Number.NEGATIVE_INFINITY;
  const windowEndMs = options.windowEndMs ?? Number.POSITIVE_INFINITY;
  return recentCompletedRequestOperations
    .filter((operation) =>
      windowsOverlap(operation.startedAtMs, operation.endedAtMs, windowStartMs, windowEndMs))
    .sort((left, right) => right.durationMs - left.durationMs || right.endedAtMs - left.endedAtMs)
    .slice(0, limit);
}

export function getEventLoopLagRequestTelemetryMetadata(
  lagMs: number,
  options: EventLoopLagRequestTelemetryOptions = {},
): Record<string, unknown> {
  const now = options.now ?? Date.now;
  const observedAtMs = now();
  const normalizedLagMs = Math.max(0, lagMs);
  const lagWindowStartMs = observedAtMs - normalizedLagMs;
  const lagWindowEndMs = observedAtMs;
  return {
    activeRequestCount: getActiveRequestTelemetryCount(),
    activeRequests: getActiveRequestTelemetrySnapshots({ limit: options.activeRequestLimit ?? 5, now }),
    lagWindowStart: toIsoTime(lagWindowStartMs),
    lagWindowEnd: toIsoTime(lagWindowEndMs),
    lagWindowStartMs,
    lagWindowEndMs,
    recentCompletedOperations: getRecentCompletedRequestOperations({
      windowStartMs: lagWindowStartMs,
      windowEndMs: lagWindowEndMs,
      limit: options.completedOperationLimit ?? 10,
    }),
    ...(normalizedLagMs > LARGE_EVENT_LOOP_LAG_MS ? getRequestTelemetryRuntimeMetadata() : {}),
  };
}

function recordSpan(
  telemetryStore: TelemetryStore | undefined,
  name: string,
  duration: number,
  metadata: Record<string, unknown>,
): void {
  try {
    telemetryStore?.recordSpan({
      name,
      duration: Math.max(0, duration),
      metadata,
      source: "server",
    });
  } catch {
    // Request telemetry must never interfere with the API response path.
  }
}

function cleanupActiveRequest(ctx: RequestTelemetryContext | undefined): void {
  const activeEntry = ctx?.activeEntry;
  if (!activeEntry) return;
  activeRequestTelemetryEntries.delete(activeEntry.key);
  activeEntry.operationStack.length = 0;
  ctx.activeEntry = undefined;
}

function setCurrentOperation(
  ctx: RequestTelemetryContext | undefined,
  operation: string,
  startedAt: number,
  metadata?: Record<string, unknown>,
): ActiveRequestOperation | undefined {
  if (!ctx?.shouldTrack || !ctx.activeEntry) return undefined;
  const entry = {
    name: operation,
    startedAt,
    ...(metadata ? { metadata } : {}),
  };
  ctx.activeEntry.operationStack.push(entry);
  return entry;
}

function clearCurrentOperation(
  ctx: RequestTelemetryContext | undefined,
  operation: ActiveRequestOperation | undefined,
): void {
  if (!operation || !ctx?.activeEntry) return;
  const stack = ctx.activeEntry.operationStack;
  const index = stack.lastIndexOf(operation);
  if (index >= 0) stack.splice(index, 1);
}

function formatErrorMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      operationError: true,
      errorName: error.name,
      errorMessage: error.message,
    };
  }
  return {
    operationError: true,
    errorMessage: String(error),
  };
}

export function recordRequestOperation(
  res: Response,
  operation: string,
  duration: number,
  metadata: Record<string, unknown> = {},
  timing?: { startedAt?: number; endedAt?: number; didThrow?: boolean },
): void {
  const ctx = getContext(res);
  if (!ctx?.shouldTrack) return;
  const startedAt = timing?.startedAt;
  const endedAt = timing?.endedAt;
  recordSpan(ctx.telemetryStore, "http.request.operation", duration, {
    ...ctx.metadataBase,
    ...metadata,
    operation,
    durationMs: Math.max(0, duration),
    ...(startedAt !== undefined ? { startedAt: toIsoTime(startedAt), startedAtMs: startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt: toIsoTime(endedAt), endedAtMs: endedAt } : {}),
    ...(timing?.didThrow ? { threw: true } : {}),
    statusCode: res.statusCode,
    headersSent: res.headersSent,
  });
}

function shouldRecordRequestOperation(duration: number, didThrow: boolean): boolean {
  return didThrow || duration >= DEFAULT_REQUEST_OPERATION_SPAN_MS;
}

export function timeSyncRequestOperation<T>(
  res: Response,
  operation: string,
  fn: () => T,
  metadata: Record<string, unknown> = {},
): T {
  const ctx = getContext(res);
  const now = ctx?.now ?? Date.now;
  const startedAt = now();
  const activeOperation = setCurrentOperation(ctx, operation, startedAt, metadata);
  let didThrow = false;
  let thrown: unknown;
  try {
    return fn();
  } catch (error) {
    didThrow = true;
    thrown = error;
    throw error;
  } finally {
    clearCurrentOperation(ctx, activeOperation);
    const endedAt = now();
    const duration = endedAt - startedAt;
    if (ctx) {
      rememberCompletedRequestOperation(buildCompletedRequestOperation(
        ctx,
        res,
        operation,
        startedAt,
        endedAt,
        metadata,
        didThrow,
      ));
    }
    if (shouldRecordRequestOperation(duration, didThrow)) {
      recordRequestOperation(res, operation, duration, {
        ...metadata,
        ...(didThrow ? formatErrorMetadata(thrown) : {}),
      }, {
        startedAt,
        endedAt,
        didThrow,
      });
    }
  }
}

export async function timeRequestOperation<T>(
  res: Response,
  operation: string,
  fn: () => T | Promise<T>,
  metadata: Record<string, unknown> = {},
): Promise<Awaited<T>> {
  const ctx = getContext(res);
  const now = ctx?.now ?? Date.now;
  const startedAt = now();
  const activeOperation = setCurrentOperation(ctx, operation, startedAt, metadata);
  let didThrow = false;
  let thrown: unknown;
  try {
    return await fn();
  } catch (error) {
    didThrow = true;
    thrown = error;
    throw error;
  } finally {
    clearCurrentOperation(ctx, activeOperation);
    const endedAt = now();
    const duration = endedAt - startedAt;
    if (ctx) {
      rememberCompletedRequestOperation(buildCompletedRequestOperation(
        ctx,
        res,
        operation,
        startedAt,
        endedAt,
        metadata,
        didThrow,
      ));
    }
    if (shouldRecordRequestOperation(duration, didThrow)) {
      recordRequestOperation(res, operation, duration, {
        ...metadata,
        ...(didThrow ? formatErrorMetadata(thrown) : {}),
      }, {
        startedAt,
        endedAt,
        didThrow,
      });
    }
  }
}

export function recordInflightRequestTelemetry(
  telemetryStore: TelemetryStore | undefined,
  options: RequestTelemetryInflightReporterOptions = {},
): number {
  if (!telemetryStore) return 0;
  const now = options.now ?? Date.now;
  const nowMs = now();
  const thresholdMs = options.thresholdMs ?? DEFAULT_INFLIGHT_REQUEST_MS;
  const repeatMs = options.repeatMs ?? DEFAULT_INFLIGHT_REPEAT_MS;
  const snapshotLimit = options.snapshotLimit ?? 5;
  const maxReports = options.maxReports ?? DEFAULT_INFLIGHT_MAX_REPORTS;
  let recorded = 0;
  let activeSnapshots: ActiveRequestTelemetrySnapshot[] | undefined;

  for (const entry of activeRequestTelemetryEntries.values()) {
    const ageMs = Math.max(0, nowMs - entry.startedAt);
    if (ageMs < thresholdMs) continue;
    if (entry.inflightReportCount >= maxReports) continue;
    if (entry.lastInflightReportAt !== undefined && nowMs - entry.lastInflightReportAt < repeatMs) continue;

    const snapshot = toActiveRequestSnapshot(entry, nowMs);
    const reportCount = entry.inflightReportCount + 1;
    recordSpan(telemetryStore, "http.request.inflight", ageMs, {
      ...entry.metadataBase,
      statusCode: snapshot.statusCode,
      headersSent: snapshot.headersSent,
      requestAgeMs: snapshot.ageMs,
      ...(snapshot.currentOperation ? { currentOperation: snapshot.currentOperation } : {}),
      operationDepth: snapshot.operationDepth,
      inflightReportCount: reportCount,
      inflightReportLimit: maxReports,
      activeRequestCount: activeRequestTelemetryEntries.size,
      activeRequests: activeSnapshots ??= getActiveRequestTelemetrySnapshots({ limit: snapshotLimit, now }),
      ...getRequestTelemetryRuntimeMetadata(),
    });
    entry.inflightReportCount = reportCount;
    entry.lastInflightReportAt = nowMs;
    recorded += 1;
  }

  return recorded;
}

export function clearRequestTelemetryForTests(): void {
  activeRequestTelemetryEntries.clear();
  recentCompletedRequestOperations.length = 0;
  activeRequestSequence = 0;
}

export function startRequestTelemetryInflightReporter(
  telemetryStore: TelemetryStore | undefined,
  options: RequestTelemetryInflightReporterOptions = {},
): RequestTelemetryInflightReporter {
  if (!telemetryStore) return { stop: () => {} };

  const intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INFLIGHT_INTERVAL_MS);
  const timer = setInterval(() => {
    recordInflightRequestTelemetry(telemetryStore, options);
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}

export function createRequestTelemetryMiddleware(
  telemetryStore: TelemetryStore | undefined,
  options: RequestTelemetryOptions = {},
): RequestHandler {
  const now = options.now ?? Date.now;
  const slowRequestMs = options.slowRequestMs ?? DEFAULT_SLOW_REQUEST_MS;
  const createRequestId = options.requestIdFactory ?? randomUUID;

  return (req, res, next) => {
    const path = stripQuery(req.originalUrl || req.url);
    const requestId = getRequestId(req.headers["x-request-id"], createRequestId);
    const startedAt = now();
    const shouldTrack = !shouldSkipTelemetry(path) && telemetryStore != null;

    res.setHeader("X-Request-Id", requestId);

    const metadataBase: RequestMetadataBase = {
      requestId,
      method: req.method,
      path,
      ...(headerToString(req.headers["content-length"]) ? { requestContentLength: headerToString(req.headers["content-length"]) } : {}),
      ...(headerToString(req.headers["user-agent"]) ? { userAgent: headerToString(req.headers["user-agent"]) } : {}),
    };
    const activeEntry: ActiveRequestTelemetryEntry | undefined = shouldTrack
      ? {
          key: `${requestId}:${++activeRequestSequence}`,
          startedAt,
          metadataBase,
          getStatusCode: () => res.statusCode,
          getHeadersSent: () => res.headersSent,
          operationStack: [],
          inflightReportCount: 0,
        }
      : undefined;
    if (activeEntry) {
      activeRequestTelemetryEntries.set(activeEntry.key, activeEntry);
    }
    (res.locals as Record<string, unknown>)[REQUEST_TELEMETRY_KEY] = {
      startedAt,
      shouldTrack,
      metadataBase,
      now,
      telemetryStore,
      activeEntry,
      failureLogged: false,
    } satisfies RequestTelemetryContext;

    let settled = false;

    res.once("finish", () => {
      settled = true;
      const ctx = (res.locals as Record<string, unknown>)[REQUEST_TELEMETRY_KEY] as RequestTelemetryContext | undefined;
      try {
        if (!shouldTrack) return;
        if (res.statusCode >= 400 && ctx?.failureLogged) return;

        const duration = Math.max(0, now() - startedAt);
        if (res.statusCode >= 400) {
          recordSpan(telemetryStore, "http.request.failed", duration, {
            ...metadataBase,
            statusCode: res.statusCode,
            responseContentLength: getResponseContentLength(res),
            headersSent: res.headersSent,
          });
          return;
        }

        if (duration >= slowRequestMs) {
          recordSpan(telemetryStore, "http.request.slow", duration, {
            ...metadataBase,
            statusCode: res.statusCode,
            responseContentLength: getResponseContentLength(res),
            headersSent: res.headersSent,
          });
        }
      } finally {
        cleanupActiveRequest(ctx);
      }
    });

    res.once("close", () => {
      if (settled) return;
      settled = true;
      const ctx = (res.locals as Record<string, unknown>)[REQUEST_TELEMETRY_KEY] as RequestTelemetryContext | undefined;

      try {
        if (!shouldTrack) return;
        const duration = Math.max(0, now() - startedAt);
        recordSpan(telemetryStore, "http.request.aborted", duration, {
          ...metadataBase,
          statusCode: res.statusCode,
          responseContentLength: getResponseContentLength(res),
          headersSent: res.headersSent,
        });
      } finally {
        cleanupActiveRequest(ctx);
      }
    });

    next();
  };
}

export function createApiJsonErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (!isTrackedParseError(err)) {
      next(err);
      return;
    }

    const ctx = (res.locals as Record<string, unknown>)[REQUEST_TELEMETRY_KEY] as RequestTelemetryContext | undefined;
    const requestId = ctx?.metadataBase.requestId;
    if (typeof requestId === "string" && !res.getHeader("X-Request-Id")) {
      res.setHeader("X-Request-Id", requestId);
    }

    if (ctx?.shouldTrack) {
      try {
        ctx.telemetryStore?.recordSpan({
          name: "http.request.failed",
          duration: Math.max(0, ctx.now() - ctx.startedAt),
          metadata: {
            ...ctx.metadataBase,
            statusCode: 400,
            parseError: true,
            errorType: err.type ?? "entity.parse.failed",
            headersSent: res.headersSent,
          },
          source: "server",
        });
        ctx.failureLogged = true;
      } catch {
        // Parse error logging must never break the response path.
      }
    }

    if (!res.headersSent) {
      res.status(400).json({ error: "Malformed JSON request body" });
      return;
    }

    next(err);
  };
}
