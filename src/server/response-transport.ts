import compression from "compression";
import type { Request, RequestHandler, Response } from "express";

/**
 * Responses below this size gain nothing from compression; the dev tunnel relay
 * round trip dominates them regardless of body size.
 */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";

/** Cache-Control for API reads: browsers may keep a copy but must revalidate every time. */
export const API_GET_CACHE_CONTROL = "private, no-cache";
/** Cache-Control for API writes and anything else that must never be reused. */
export const API_MUTATION_CACHE_CONTROL = "no-store";

export function isEventStreamResponse(res: Pick<Response, "getHeader">): boolean {
  const contentType = res.getHeader("Content-Type");
  const value = Array.isArray(contentType) ? contentType.join(",") : String(contentType ?? "");
  return value.toLowerCase().includes(EVENT_STREAM_CONTENT_TYPE);
}

/**
 * SSE bodies must reach the client as they are written; a compression stream would
 * buffer events until its window fills. Everything else defers to the default
 * compressible-type check.
 */
export function shouldCompressResponse(req: Request, res: Response): boolean {
  if (isEventStreamResponse(res)) return false;
  return compression.filter(req, res);
}

export function createResponseCompressionMiddleware(): RequestHandler {
  return compression({
    threshold: COMPRESSION_THRESHOLD_BYTES,
    filter: shouldCompressResponse,
  });
}

/**
 * Express already emits a weak ETag for JSON bodies and answers matching
 * If-None-Match with 304. `no-store` threw that away by forbidding the browser from
 * keeping anything to revalidate against, so every poll re-downloaded the full body.
 */
export function resolveApiCacheControl(method: string): string {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD"
    ? API_GET_CACHE_CONTROL
    : API_MUTATION_CACHE_CONTROL;
}

export function createApiCacheControlMiddleware(): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Cache-Control", resolveApiCacheControl(req.method));
    allowScriptConditionalRevalidation(req);
    next();
  };
}

/**
 * When page script sets If-None-Match itself, the Fetch spec forces the request into
 * cache mode "no-store" and browsers append `Cache-Control: no-cache` + `Pragma:
 * no-cache` to it. Express's freshness check (`fresh`) treats a request-side
 * `no-cache` as "never 304", so every client revalidation came back 200 with a full
 * body. A conditional request *is* origin validation, which is exactly what the
 * request directive asks for, so drop the request-side veto and let the ETag compare
 * decide.
 */
export function allowScriptConditionalRevalidation(
  req: Pick<Request, "method" | "headers">,
): boolean {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (!req.headers["if-none-match"]) return false;
  if (req.headers["cache-control"] === undefined && req.headers.pragma === undefined) return false;
  delete req.headers["cache-control"];
  delete req.headers.pragma;
  return true;
}
