import compression from "compression";
import type { Request, RequestHandler, Response } from "express";

/** Below this size the dev tunnel round trip dominates, so compression gains nothing. */
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

/** Never compresses SSE: a compression stream would buffer events until its window fills. */
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

/** Not no-store: the browser must keep bodies to revalidate Express's weak ETag and get 304s. */
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

/** Script-set If-None-Match makes browsers add no-cache, which blocks Express 304s; drop it. */
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
