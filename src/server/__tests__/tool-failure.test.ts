import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyToolFailure } from "../../shared/tool-failure.js";
import { recordToolFailure } from "../tool-failure-telemetry.js";

afterEach(() => vi.useRealTimers());

describe("tool failure classification", () => {
  it.each([
    ["Kusto request failed: 403 Forbidden", "permission"],
    ["Kusto403", "permission"],
    ["AuthorizationFailed: access denied", "permission"],
    ["KustoRequestDeniedException: not authorized to query this database", "permission"],
    ["401 Unauthorized: token expired", "authentication"],
    ["ExpiredAuthenticationToken", "authentication"],
    ["Authentication required: credentials missing", "authentication"],
    ["Bad request 400: SemanticError: ring timeline empty", "query-server"],
    ["KustoBadRequestException: 400 Bad Request, assert(ring timeline empty)", "query-server"],
    ["Invalid filter: slash property paths are not supported", "invalid-input"],
    ["MCP error -32602: invalid params", "invalid-input"],
    ["Kusto assert: ring timeline empty", "query-server"],
    ["SemanticError: column not found", "query-server"],
    ["ETIMEDOUT: deadline exceeded", "timeout"],
    ["ECONNRESET: connection closed", "transport"],
    ["MCP error -32001: Session not found", "transport"],
    ["HTTP 429 Too Many Requests", "throttled"],
    ["TooManyRequests", "throttled"],
    ["HTTP 404: resource missing", "not-found"],
    ["NotFound", "not-found"],
    ["Operation is not supported on this route", "invalid-input"],
    ["Tool initialization incomplete", "initialization"],
    ['MCP tool catalog changed before tool "demo-read" could be invoked: MCP snapshot changed while verifying cached tools', "catalog-changed"],
    ['MCP tool catalog changed before tool "demo-read" could be invoked: Cached MCP tool "read" changed before it could be invoked', "catalog-changed"],
    ['MCP tool catalog changed before tool "demo-read" could be invoked: Failed to verify cached MCP tools: MCP request timed out after 60000 ms', "catalog-changed"],
    ['MCP tool catalog changed before tool "demo-read" could be invoked: Failed to verify cached MCP tools: MCP request failed: Transport closed', "catalog-changed"],
    ['MCP tool catalog changed before tool "demo-read" could be invoked: Failed to verify cached MCP tools: MCP error -32602: request _meta is missing or has malformed required fields', "catalog-changed"],
    ["Something went wrong", "unknown"],
  ])("classifies %s as %s", (text, category) => {
    expect(classifyToolFailure(text).category).toBe(category);
  });

  it("does not recommend reconnecting for resource authorization, input, or semantic failures", () => {
    for (const text of ["403 Forbidden", "Invalid input", "Kusto assert: ring timeline empty"]) {
      expect(classifyToolFailure(text).retryable).toBe(false);
    }
  });

  it("does not recommend automatic retry for permanent 403 or authentication failures", () => {
    const permission = classifyToolFailure("403 Forbidden: request not authorized");
    expect(permission).toMatchObject({ category: "permission", retryable: false });
    expect(permission.guidance).toContain("403 is not evidence of expired authentication");
    expect(classifyToolFailure("401 Unauthorized: token expired")).toMatchObject({ category: "authentication", retryable: false });
    expect(classifyToolFailure("Tool initialization failed: missing canonical tools").retryable).toBe(false);
  });

  it("marks a call the runtime never sent, because the server's tool list was still being checked, as safe to repeat", () => {
    const failure = classifyToolFailure({
      error: { message: 'MCP tool catalog changed before tool "demo-read" could be invoked: MCP snapshot changed while verifying cached tools', code: "failure" },
    });
    expect(failure).toMatchObject({ category: "catalog-changed", retryable: true });
    expect(failure.guidance).toContain("Call the tool again");
  });

  it("reads structured errors and MCP text content without serializing arbitrary objects", () => {
    expect(classifyToolFailure({ error: { statusCode: 403, message: "denied" } }).category).toBe("permission");
    expect(classifyToolFailure({ error: { statusCode: 401, message: "token expired" } }).category).toBe("authentication");
    expect(classifyToolFailure({ content: [{ type: "text", text: "Invalid params" }] }).category).toBe("invalid-input");
    expect(classifyToolFailure(new Error("connection closed")).category).toBe("transport");
    const cyclic: Record<string, unknown> = {};
    cyclic.error = cyclic;
    expect(classifyToolFailure(cyclic).category).toBe("unknown");
  });

  it("handles absent and non-text results without throwing", () => {
    expect(classifyToolFailure(undefined).category).toBe("unknown");
    expect(classifyToolFailure(null).category).toBe("unknown");
  });

  it.each([
    [429, "throttled"],
    [401, "authentication"],
    [403, "permission"],
    [404, "not-found"],
    [408, "timeout"],
    [503, "query-server"],
  ])("prefers structured HTTP status %s to conflicting message text", (status, category) => {
    expect(classifyToolFailure({ error: { statusCode: status, message: "403 Forbidden, HTTP 429" } }))
      .toMatchObject({ statusCode: status, category });
  });

  it("retains standard diagnostic fields from nested errors without their message", () => {
    const requestId = "12345678-1234-1234-1234-123456789abc";
    const correlationId = "abcdefab-1234-1234-1234-123456789abc";
    const failure = classifyToolFailure({
      error: {
        code: "failure",
        cause: {
          response: {
            status: 429,
            headers: { "Retry-After": "60", "request-id": requestId },
            data: { error: { code: "TooManyRequests", correlationId, message: "private request body" } },
          },
        },
      },
    });
    expect(failure).toMatchObject({
      category: "throttled", statusCode: 429, errorCode: "TooManyRequests",
      retryAfterMs: 60_000, requestId, correlationId,
    });
    expect(JSON.stringify(failure)).not.toContain("private request body");
  });

  it("extracts only protocol-shaped diagnostics from text-only failures", () => {
    const correlationId = "12345678-1234-1234-1234-123456789abc";
    expect(classifyToolFailure({
      error: { message: `HTTP 429 Too Many Requests. Please retry this request after 1 minute.\r\nCorrelationId: ${correlationId}` },
    })).toMatchObject({
      category: "throttled", statusCode: 429, retryAfterMs: 60_000, correlationId,
    });
    expect(classifyToolFailure({ content: [{ type: "text", text: "HTTP 429. Retry-After: 2" }] }))
      .toMatchObject({ statusCode: 429, retryAfterMs: 2_000 });
  });

  it("supports numeric retry delays, HTTP dates and Headers without retaining other headers", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    expect(classifyToolFailure({
      response: { status: 429, headers: new Headers({ "Retry-After": "Mon, 19 Oct 2026 12:00:30 GMT" }) },
    }).retryAfterMs).toBe(30_000);
    expect(classifyToolFailure({ error: { retryAfterMs: 125 } }).retryAfterMs).toBe(125);
    expect(classifyToolFailure({ error: { retryAfterSeconds: 1.5 } }).retryAfterMs).toBe(1_500);
  });

  it("reads standard runtime and JSON-RPC codes", () => {
    expect(classifyToolFailure(Object.assign(new Error("opaque"), { code: "ETIMEDOUT" })))
      .toMatchObject({ category: "timeout", errorCode: "ETIMEDOUT" });
    expect(classifyToolFailure({ error: { code: -32602, message: "opaque" } }))
      .toMatchObject({ category: "invalid-input", errorCode: -32602 });
  });

  it.each(["VendorFailure", "Vendor.Locked-42", "constructor", "__proto__", "x".repeat(64), 123456, -42001, 0])(
    "retains unfamiliar structured code %s without guessing its category",
    (code) => {
      expect(classifyToolFailure({ error: { code, message: "opaque provider failure" } }))
        .toMatchObject({ category: "unknown", errorCode: code });
    },
  );

  it.each(["", "x".repeat(65), "arbitrary error text", "https://example.com", "Bearer credential", NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, true, {}])(
    "omits malformed structured code %s",
    (code) => {
      expect(classifyToolFailure({ error: { code } })).not.toHaveProperty("errorCode");
    },
  );

  it("keeps the underlying code rather than a generic wrapper code", () => {
    expect(classifyToolFailure({
      error: { code: "WrapperFailure", cause: { code: "VendorFailure" } },
    })).toMatchObject({ category: "unknown", errorCode: "VendorFailure" });
  });

  it("keeps known-code classification case-insensitive without rewriting the recorded code", () => {
    expect(classifyToolFailure({ error: { code: "etimedout", message: "opaque" } }))
      .toMatchObject({ category: "timeout", errorCode: "etimedout" });
  });

  it("does not let an unfamiliar code suppress other failure evidence", () => {
    expect(classifyToolFailure({ error: { code: "VendorFailure", message: "403 Forbidden" } }))
      .toMatchObject({ category: "permission", errorCode: "VendorFailure" });
  });

  it("omits malformed diagnostics and sensitive request content", () => {
    const secret = "private-tool-payload";
    const failure = classifyToolFailure({
      statusCode: 999, code: `arbitrary error text: ${secret}`, requestId: secret, correlationId: secret,
      retryAfterMs: -1, retryAfterSeconds: Infinity,
      message: `Failed to send ${secret}`,
      headers: { Authorization: `Bearer ${secret}`, Cookie: secret, "Retry-After": "not a delay" },
      arguments: { secret }, result: { body: secret },
    });
    expect(failure).toEqual({
      category: "unknown",
      guidance: expect.any(String),
      retryable: false,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("keeps runtime catalog failures distinct even when their cause contains HTTP diagnostics", () => {
    expect(classifyToolFailure({
      message: "MCP tool catalog changed before tool could be invoked",
      cause: { statusCode: 429 },
    })).toMatchObject({ category: "catalog-changed", statusCode: 429 });
  });
});

describe("tool failure telemetry", () => {
  it("records a bounded, safe failure with call and watch context", () => {
    const recordSpan = vi.fn();
    const failure = recordToolFailure(
      { error: { status: 429, message: "private-tool-payload" } },
      {
        sessionId: "parent", toolName: "t".repeat(300), toolCallId: "c".repeat(300),
        durationMs: 25, deferId: "interval_1", runCount: 2, workerSessionId: "worker",
      },
      recordSpan,
    );
    expect(recordSpan).toHaveBeenCalledExactlyOnceWith("tool.failure", 25, "parent", {
      toolName: "t".repeat(256), toolCallId: "c".repeat(256),
      deferId: "interval_1", runCount: 2, workerSessionId: "worker",
      ...failure,
    });
    expect(JSON.stringify(recordSpan.mock.calls)).not.toContain("private-tool-payload");
  });

  it("reports persistence failure without changing the tool diagnosis or retrying", () => {
    const recordSpan = vi.fn(() => { throw new Error("private persistence details"); });
    const logger = { warn: vi.fn() };
    expect(recordToolFailure("HTTP 429", { sessionId: "session", toolName: "read" }, recordSpan, logger))
      .toMatchObject({ category: "throttled" });
    expect(recordSpan).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("[tool.failure] Failed to persist tool failure diagnostics.");
  });

  it("still diagnoses failures when telemetry is unavailable", () => {
    expect(recordToolFailure("HTTP 403", { sessionId: "session", toolName: "read" }, undefined))
      .toMatchObject({ category: "permission" });
  });
});
