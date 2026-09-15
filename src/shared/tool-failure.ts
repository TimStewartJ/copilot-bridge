export type ToolFailureCategory = "transport" | "timeout" | "permission" | "authentication" | "invalid-input" | "query-server" | "initialization" | "unknown";

export interface ToolFailure {
  category: ToolFailureCategory;
  guidance: string;
  retryable: boolean;
}

const GUIDANCE: Record<ToolFailureCategory, [string, boolean]> = {
  transport: ["Check the MCP connection and retry after reconnecting.", true],
  timeout: ["The request timed out. Check service health or narrow the request before retrying.", true],
  permission: ["The request was denied by the resource. Check the signed-in identity and resource permissions. A 403 is not evidence of expired authentication; retrying or signing in again will not grant missing permissions.", false],
  authentication: ["Authentication is missing or expired. Check the sign-in or credential configuration before manually retrying. A connected MCP server does not guarantee valid credentials for the resource.", false],
  "invalid-input": ["Correct the arguments to match the tool contract. Reconnecting will not fix invalid input.", false],
  "query-server": ["Check the query, data availability, and server error. Reconnecting is not usually the fix.", false],
  initialization: ["Tool initialization did not complete. Inspect the initialization error and fix its cause before reloading or retrying.", false],
  unknown: ["Inspect the tool error before retrying. Connection status alone does not explain this failure.", false],
};

function failureText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.slice(0, 4_096);
  if (value instanceof Error) return value.message.slice(0, 4_096);
  if (!value || typeof value !== "object" || depth >= 3) return "";
  if (Array.isArray(value)) return value.slice(0, 4).map((entry) => failureText(entry, depth + 1)).join(" ");
  const record = value as Record<string, unknown>;
  return ["error", "message", "text", "content", "code", "statusCode", "status"].map((key) => {
    const field = record[key];
    return typeof field === "number" ? String(field) : failureText(field, depth + 1);
  }).join(" ").slice(0, 8_192);
}

/** Classifies an already-failed execution, not arbitrary successful tool output or debug discovery logs. */
export function classifyToolFailure(result: unknown): ToolFailure {
  const text = failureText(result);
  let category: ToolFailureCategory = "unknown";
  if (/tool.{0,30}initializ|initialization.{0,30}(?:pending|incomplete|not ready)|tools? (?:are |is )?not ready/i.test(text)) category = "initialization";
  else if (/\b(?:403|Kusto403|forbidden|AuthorizationFailed|KustoRequestDeniedException|access denied|permission denied|insufficient privileges)\b/i.test(text)) category = "permission";
  else if (/\b(?:401|unauthorized|AuthenticationFailed|invalid_token|ExpiredAuthenticationToken|token expired|expired token|credentials expired|authentication required)\b|(?:token|credential|authentication).{0,40}(?:expired|missing|invalid)|(?:expired|missing|invalid).{0,40}(?:token|credential)/i.test(text)) category = "authentication";
  else if (/\b(?:assert(?:ion)?|SemanticError|SyntaxError|query error|KustoBadRequestException)\b|semantic error|ring timeline.{0,40}empty/i.test(text)) category = "query-server";
  else if (/\b(?:invalid (?:params|parameters|arguments|input|filter)|bad request|validation error|schema validation|contract violation|unsupported (?:filter|parameter)|InefficientFilter)\b|\b-32602\b|(?:filter|property|path).{0,80}(?:not supported|not filterable|invalid)|slash.{0,40}filter/i.test(text)) category = "invalid-input";
  else if (/\b(?:timed? out|timeout|ETIMEDOUT|deadline exceeded)\b/i.test(text)) category = "timeout";
  else if (/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|connection closed|connection lost|socket hang up|transport error|Session not found)\b/i.test(text)) category = "transport";
  else if (/\b(?:500|502|503|504|internal server error|service unavailable)\b/i.test(text)) category = "query-server";
  const [guidance, retryable] = GUIDANCE[category];
  return { category, guidance, retryable };
}
