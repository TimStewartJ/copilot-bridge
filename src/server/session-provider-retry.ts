import { isRecord } from "../shared/is-record.js";

export const PROVIDER_RETRY_DELAY_MS = 5_000;

export const PROVIDER_RETRY_PROMPT =
  "The model provider returned an internal server error, so Bridge is retrying this response once. "
  + "Continue from the saved conversation and finish answering the latest user request. "
  + "Check existing results before repeating any tool calls or actions that may already have completed.";

export function isRetryableProviderError(data: unknown): boolean {
  if (!isRecord(data) || (data.statusCode !== 400 && data.statusCode !== 500)) return false;
  return typeof data.message === "string"
    && /^(?:Execution failed:\s*)?(?:CAPIError:\s*)?(?:400|500)\s+internal server error(?:\s*\(Request[- ]ID: [^)]+\))?\s*$/i.test(data.message);
}

export function providerErrorMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  const requestId = typeof data.providerCallId === "string"
    && /^[A-Za-z0-9_.:-]{1,200}$/.test(data.providerCallId) ? data.providerCallId : undefined;
  return {
    statusCode: typeof data.statusCode === "number" ? data.statusCode : undefined,
    providerCallId: requestId,
    category: isRetryableProviderError(data) ? "internal_server_error" : "other",
  };
}
