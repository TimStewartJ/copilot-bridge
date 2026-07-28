import { describe, expect, it } from "vitest";
import { bridgeToolResult, getToolExecutionDisplayText, toolFailure } from "../tool-results.js";

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

  it("surfaces respond-or-defer Bridge tool guidance", () => {
    const result = bridgeToolResult({
      success: true,
      summary: "Job queued.",
      terminal: true,
      toolNextAction: "respond_or_defer",
      retryable: false,
    });

    expect(result.content[0].text).toContain("schedule one same-session defer with defer_create");
    expect(result.content[0].text).toContain("do not synchronously poll");
    expect(result.content[0].text).toContain('"nextAction":"respond_or_defer"');
  });

  it("allows relevant follow-up tools after a successful background result", () => {
    const result = bridgeToolResult({
      success: true,
      summary: "Preview is ready.",
      terminal: true,
      toolNextAction: "proceed",
      retryable: false,
    });

    expect(result.content[0].text).toContain("proceed with relevant follow-up tools");
    expect(result.content[0].text).toContain("do not re-poll this status");
    expect(result.content[0].text).toContain('"nextAction":"proceed"');
  });
});
