import { isRecord } from "./is-record.js";

export type ToolFailureCategory = "transport" | "timeout" | "permission" | "authentication" | "invalid-input" | "query-server" | "initialization" | "catalog-changed" | "throttled" | "not-found" | "unknown";

export interface ToolFailure {
  category: ToolFailureCategory;
  guidance: string;
  retryable: boolean;
  statusCode?: number;
  errorCode?: string | number;
  retryAfterMs?: number;
  requestId?: string;
  correlationId?: string;
}

const GUIDANCE: Record<ToolFailureCategory, [string, boolean]> = {
  transport: ["Check the MCP connection and retry after reconnecting.", true],
  timeout: ["The request timed out. Check service health or narrow the request before retrying.", true],
  permission: ["The request was denied by the resource. Check the signed-in identity and resource permissions. A 403 is not evidence of expired authentication; retrying or signing in again will not grant missing permissions.", false],
  authentication: ["Authentication is missing or expired. Check the sign-in or credential configuration before manually retrying. A connected MCP server does not guarantee valid credentials for the resource.", false],
  "invalid-input": ["Correct the arguments to match the tool contract. Reconnecting will not fix invalid input.", false],
  "query-server": ["Check the query, data availability, and server error. Reconnecting is not usually the fix.", false],
  initialization: ["Tool initialization did not complete. Inspect the initialization error and fix its cause before reloading or retrying.", false],
  "catalog-changed": ["The MCP server was still connecting and the runtime could not confirm its tool list, so the call was not sent. Call the tool again. If it fails the same way, check that server's connection.", true],
  throttled: ["The service is rate limiting requests. Honor its retry delay, and retry only if the operation is safe to repeat.", true],
  "not-found": ["The requested resource was not found. Check the resource identifier and route before retrying.", false],
  unknown: ["Inspect the tool error before retrying. Connection status alone does not explain this failure.", false],
};

const CODE_CATEGORIES: Record<string, ToolFailureCategory> = {
  TooManyRequests: "throttled",
  NotFound: "not-found",
  Unauthorized: "authentication",
  Forbidden: "permission",
  AccessDenied: "permission",
  InsufficientPrivileges: "permission",
  InvalidArgument: "invalid-input",
  InvalidParams: "invalid-input",
  BadRequest: "invalid-input",
  InternalServerError: "query-server",
  ServiceUnavailable: "query-server",
  GatewayTimeout: "timeout",
  ETIMEDOUT: "timeout",
  ECONNRESET: "transport",
  ECONNREFUSED: "transport",
  EPIPE: "transport",
  ENOTFOUND: "transport",
};
const FAILURE_FIELDS = ["error", "result", "cause", "response", "data", "innerError", "content"] as const;
const DIAGNOSTIC_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
type FailureDetails = Omit<ToolFailure, "category" | "guidance" | "retryable">;

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : undefined;
}

function retryDelay(value: unknown, multiplier = 1_000): number | undefined {
  const number = finiteNumber(value);
  if (number !== undefined) {
    const delay = number * multiplier;
    return delay >= 0 && delay <= Number.MAX_SAFE_INTEGER ? delay : undefined;
  }
  if (typeof value !== "string" || !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} /i.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function boundedErrorCode(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/.test(value)
    ? value : undefined;
}

function failureDetails(value: unknown, text: string): FailureDetails {
  const details: FailureDetails = {};
  const seen = new Set<object>();
  function visit(value: unknown, depth = 0): void {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value) || seen.size >= 32) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 4)) visit(entry, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const status = finiteNumber(value.statusCode ?? value.status);
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
      details.statusCode ??= status;
    }
    details.errorCode = boundedErrorCode(value.code) ?? details.errorCode;
    details.retryAfterMs ??= retryDelay(value.retryAfterMs, 1) ?? retryDelay(value.retryAfterSeconds);
    for (const field of ["requestId", "correlationId"] as const) {
      if (typeof value[field] === "string" && DIAGNOSTIC_ID.test(value[field])) details[field] ??= value[field];
    }
    const headers = value.headers;
    if (headers && typeof headers === "object") {
      const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
      for (const [key, value] of entries.slice(0, 32)) {
        const name = key.toLowerCase();
        if (name === "retry-after") details.retryAfterMs ??= retryDelay(value);
        if (typeof value !== "string" || !DIAGNOSTIC_ID.test(value)) continue;
        if (name === "request-id" || name === "x-request-id" || name === "x-ms-request-id") details.requestId ??= value;
        if (name === "correlation-id" || name === "x-correlation-id") details.correlationId ??= value;
      }
    }
    for (const field of FAILURE_FIELDS) visit(value[field], depth + 1);
  }
  visit(value);
  // Only protocol-shaped fields are retained from text; errors can echo private request bodies.
  const status = text.match(/\b(?:HTTP(?:\/[\d.]+)?|status(?:\s+code|Code)?)\s*[:=]?\s*([45]\d{2})\b/i);
  if (status) details.statusCode ??= Number(status[1]);
  const delay = text.match(/\bretry-after\s*[:=]\s*(\d+(?:\.\d+)?)/i)
    ?? text.match(/\bretry(?:\s+(?:this|the)\s+request)?\s+(?:again\s+)?(?:after|in)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|minutes?|hours?)\b/i);
  if (delay) {
    const multiplier = /^m(?:illiseconds?|s)$/i.test(delay[2] ?? "") ? 1
      : /^minutes?$/i.test(delay[2] ?? "") ? 60_000
        : /^hours?$/i.test(delay[2] ?? "") ? 3_600_000 : 1_000;
    details.retryAfterMs ??= retryDelay(delay[1], multiplier);
  }
  for (const field of ["requestId", "correlationId"] as const) {
    const label = field === "requestId" ? "request" : "correlation";
    const id = text.match(new RegExp(`\\b${label}[-_ ]?id\\s*[:=]\\s*([a-f0-9-]{32,36})\\b`, "i"))?.[1];
    if (id && DIAGNOSTIC_ID.test(id)) details[field] ??= id;
  }
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

function failureText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.slice(0, 4_096);
  if (value instanceof Error) return value.message.slice(0, 4_096);
  if (!value || typeof value !== "object" || depth >= 3) return "";
  if (Array.isArray(value)) return value.slice(0, 4).map((entry) => failureText(entry, depth + 1)).join(" ");
  const record = value as Record<string, unknown>;
  return [...FAILURE_FIELDS, "message", "text", "textResultForLlm", "detailedContent", "sessionLog", "code", "statusCode", "status"].map((key) => {
    const field = record[key];
    return typeof field === "number" ? String(field) : failureText(field, depth + 1);
  }).join(" ").slice(0, 8_192);
}

/** Classifies an already-failed execution, not arbitrary successful tool output or debug discovery logs. */
export function classifyToolFailure(result: unknown): ToolFailure {
  const text = failureText(result);
  const details = failureDetails(result, text);
  const codeCategory = Object.entries(CODE_CATEGORIES)
    .find(([code]) => code.toLowerCase() === String(details.errorCode).toLowerCase())?.[1];
  let category: ToolFailureCategory = "unknown";
  // The runtime offers a connecting server's tools from a saved list and checks that list on first use. Its
  // message ends with the reason (a timeout, a closed transport, an error code), which must not pick the category.
  if (/MCP tool catalog changed before tool/i.test(text)) category = "catalog-changed";
  else if (/tool.{0,30}initializ|initialization.{0,30}(?:pending|incomplete|not ready)|tools? (?:are |is )?not ready/i.test(text)) category = "initialization";
  else if (details.statusCode === 429) category = "throttled";
  else if (details.statusCode === 401) category = "authentication";
  else if (details.statusCode === 403) category = "permission";
  else if (details.statusCode === 404) category = "not-found";
  else if (details.statusCode === 408) category = "timeout";
  else if (details.statusCode !== undefined && details.statusCode >= 500) category = "query-server";
  else if (codeCategory !== undefined) category = codeCategory;
  else if (details.errorCode === -32602 || details.errorCode === -32600 || details.errorCode === -32700) category = "invalid-input";
  else if (/\b(?:429|TooManyRequests|too many requests|rate limit(?:ed|ing)?)\b/i.test(text)) category = "throttled";
  else if (/\b(?:403|Kusto403|forbidden|AuthorizationFailed|KustoRequestDeniedException|access denied|permission denied|insufficient privileges)\b/i.test(text)) category = "permission";
  else if (/\b(?:401|unauthorized|AuthenticationFailed|invalid_token|ExpiredAuthenticationToken|token expired|expired token|credentials expired|authentication required)\b|(?:token|credential|authentication).{0,40}(?:expired|missing|invalid)|(?:expired|missing|invalid).{0,40}(?:token|credential)/i.test(text)) category = "authentication";
  else if (/\b(?:assert(?:ion)?|SemanticError|SyntaxError|query error|KustoBadRequestException)\b|semantic error|ring timeline.{0,40}empty/i.test(text)) category = "query-server";
  else if (/\b(?:invalid (?:params|parameters|arguments|input|filter)|bad request|validation error|schema validation|contract violation|unsupported (?:filter|parameter)|InefficientFilter)\b|\b-32602\b|(?:filter|property|path).{0,80}(?:not supported|not filterable|invalid)|slash.{0,40}filter|not supported on this route/i.test(text)) category = "invalid-input";
  else if (/\b(?:timed? out|timeout|ETIMEDOUT|deadline exceeded)\b/i.test(text)) category = "timeout";
  else if (/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|connection closed|connection lost|socket hang up|transport error|Session not found)\b/i.test(text)) category = "transport";
  else if (/\b(?:NotFound|not found)\b/i.test(text)) category = "not-found";
  else if (/\b(?:500|502|503|504|internal server error|service unavailable)\b/i.test(text)) category = "query-server";
  const [guidance, retryable] = GUIDANCE[category];
  return { category, guidance, retryable, ...details };
}
