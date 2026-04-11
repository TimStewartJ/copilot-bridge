import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { TelemetryStore } from "./telemetry-store.js";

const DEFAULT_SLOW_REQUEST_MS = 1_500;
const API_SUBPATH_RE = /^(?:\/staging\/[^/]+)?\/api(?<subpath>\/.*)?$/;
const SESSION_STREAM_SUBPATH_RE = /^\/sessions\/[^/]+\/stream$/;
const REQUEST_TELEMETRY_KEY = "__requestTelemetry";

type RequestTelemetryContext = {
  startedAt: number;
  shouldTrack: boolean;
  metadataBase: Record<string, unknown>;
  telemetryStore?: TelemetryStore;
  failureLogged?: boolean;
};

export interface RequestTelemetryOptions {
  slowRequestMs?: number;
  now?: () => number;
  requestIdFactory?: () => string;
}

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

    const metadataBase = {
      requestId,
      method: req.method,
      path,
      requestContentLength: headerToString(req.headers["content-length"]),
      userAgent: headerToString(req.headers["user-agent"]),
    };
    (res.locals as Record<string, unknown>)[REQUEST_TELEMETRY_KEY] = {
      startedAt,
      shouldTrack,
      metadataBase,
      telemetryStore,
      failureLogged: false,
    } satisfies RequestTelemetryContext;

    let settled = false;

    const record = (name: string, duration: number, metadata: Record<string, unknown>): void => {
      try {
        telemetryStore?.recordSpan({
          name,
          duration,
          metadata,
          source: "server",
        });
      } catch {
        // Request telemetry must never interfere with the API response path.
      }
    };

    res.once("finish", () => {
      settled = true;
      if (!shouldTrack) return;
      const ctx = (res.locals as Record<string, unknown>)[REQUEST_TELEMETRY_KEY] as RequestTelemetryContext | undefined;
      if (res.statusCode >= 400 && ctx?.failureLogged) return;

      const duration = Math.max(0, now() - startedAt);
      if (res.statusCode >= 400) {
        record("http.request.failed", duration, {
          ...metadataBase,
          statusCode: res.statusCode,
          responseContentLength: getResponseContentLength(res),
          headersSent: res.headersSent,
        });
        return;
      }

      if (duration >= slowRequestMs) {
        record("http.request.slow", duration, {
          ...metadataBase,
          statusCode: res.statusCode,
          responseContentLength: getResponseContentLength(res),
          headersSent: res.headersSent,
        });
      }
    });

    res.once("close", () => {
      if (settled || !shouldTrack) return;
      settled = true;

      const duration = Math.max(0, now() - startedAt);
      record("http.request.aborted", duration, {
        ...metadataBase,
        statusCode: res.statusCode,
        responseContentLength: getResponseContentLength(res),
        headersSent: res.headersSent,
      });
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
          duration: Math.max(0, Date.now() - ctx.startedAt),
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
