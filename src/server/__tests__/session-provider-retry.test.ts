import { describe, expect, it } from "vitest";
import { isRetryableProviderError, providerErrorMetadata } from "../session-provider-retry.js";

describe("provider error classification", () => {
  it.each([400, 500])("accepts an explicit internal server error with status %s", (statusCode) => {
    expect(isRetryableProviderError({
      statusCode,
      message: `Execution failed: ${statusCode} internal server error (Request ID: request-1)`,
    })).toBe(true);
  });

  it.each([
    { statusCode: 400, message: "Execution failed: 400 Bad Request" },
    { statusCode: 400, message: "Execution failed: 400 Duplicate item found" },
    { statusCode: 400, message: "Execution failed: 400 The requested model is not supported." },
    { statusCode: 400, message: "Execution failed: 400 This request was blocked by our safety systems." },
    { statusCode: 400, message: "Execution failed: 400 input item ID does not belong to this connection" },
    { statusCode: 503, message: "Execution failed: 503 internal server error" },
    { message: "Execution failed: 400 internal server error" },
    { statusCode: 400, message: "A tool printed 400 internal server error" },
    null,
  ])("does not retry other failures: %j", (data) => {
    expect(isRetryableProviderError(data)).toBe(false);
  });

  it("records classification and bounded identifiers, not the error body", () => {
    expect(providerErrorMetadata({
      statusCode: 400,
      providerCallId: "request-1",
      message: "Execution failed: 400 internal server error",
      stack: "private stack",
    })).toEqual({ statusCode: 400, providerCallId: "request-1", category: "internal_server_error" });
    expect(providerErrorMetadata({ providerCallId: "private\nbody" }).providerCallId).toBeUndefined();
  });
});
