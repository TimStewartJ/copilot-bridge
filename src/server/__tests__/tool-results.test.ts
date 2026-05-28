import { describe, expect, it } from "vitest";
import { bridgeToolResult, err, getToolExecutionDisplayText, ok, toolFailure, type Result } from "../tool-results.js";

describe("tool results", () => {
  it("sends actionable failure detail to the model while preserving UI session logs", () => {
    expect(toolFailure("Unable to read the page", {
      detail: "Unable to read the page: network idle wait timed out after 30s.",
      sessionLog: "network idle wait timed out after 30s while reading https://example.com",
    })).toEqual({
      textResultForLlm: "Unable to read the page: network idle wait timed out after 30s.",
      resultType: "failure",
      sessionLog: "network idle wait timed out after 30s while reading https://example.com",
    });
  });

  it("keeps summary-only failures in the SDK error field", () => {
    expect(toolFailure("Task missing-task not found")).toEqual({
      textResultForLlm: "Task missing-task not found",
      resultType: "failure",
      error: "Task missing-task not found",
    });
  });

  it("renders raw failure ToolResultObjects without relying on error.message", () => {
    expect(getToolExecutionDisplayText({
      success: false,
      result: toolFailure("Failed to capture page", {
        detail: "Failed to capture page: snapshot failed",
        sessionLog: "URL: https://example.com\n\nFailed to capture page: snapshot failed",
      }),
    })).toBe("URL: https://example.com\n\nFailed to capture page: snapshot failed");
  });

  it("creates normalized internal ok/error results", () => {
    const success: Result<number> = ok(42);
    const failure: Result<number> = err("broken");

    expect(success).toEqual({ ok: true, value: 42 });
    expect(failure).toEqual({ ok: false, error: "broken" });
  });

  it("surfaces Bridge tool control contracts in result text", () => {
    const result = bridgeToolResult({
      success: true,
      summary: "Job finished.",
      terminal: true,
      toolNextAction: "respond",
      retryable: false,
    });

    expect(result.content[0].text).toContain("Job finished.");
    expect(result.content[0].text).toContain('"terminal":true');
    expect(result.content[0].text).toContain('"nextAction":"respond"');
    expect(result.message).toBe("Job finished.");
  });
});
