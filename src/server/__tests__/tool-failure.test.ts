import { describe, expect, it } from "vitest";
import { classifyToolFailure } from "../../shared/tool-failure.js";

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
    ["Tool initialization incomplete", "initialization"],
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
});
