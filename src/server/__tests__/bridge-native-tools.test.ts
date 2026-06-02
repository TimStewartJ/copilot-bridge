import { describe, expect, it, vi } from "vitest";

import {
  convertBridgeToolResultToSdk,
  createNativeBridgeTools,
} from "../bridge-native-tools.js";
import { toolFailure } from "../tool-results.js";
import type { BridgeToolDefinition } from "../agent-tools-mcp/server.js";

function createInvocation(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    toolCallId: "tool-call-1",
    toolName: "sample_tool",
    arguments: {},
    ...overrides,
  } as any;
}

describe("bridge-native-tools", () => {
  it("creates eager canonical SDK tools and preserves Bridge invocation context", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const definition: BridgeToolDefinition = {
      name: "sample_tool",
      description: "Sample tool",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
      handler,
    };

    const [tool] = createNativeBridgeTools([definition]);

    expect(tool).toMatchObject({
      name: "sample_tool",
      description: "Sample tool",
      parameters: definition.inputSchema,
      defer: "never",
      skipPermission: true,
    });

    await expect(tool.handler!({ value: "x" }, createInvocation()))
      .resolves.toMatchObject({
        textResultForLlm: "ok",
        resultType: "success",
      });
    expect(handler).toHaveBeenCalledWith(
      { value: "x" },
      expect.objectContaining({
        sessionId: "session-1",
        requestId: "tool-call-1",
        toolCallId: "tool-call-1",
      }),
    );
  });

  it("converts Bridge failure results into SDK failure results without stringifying", () => {
    const result = convertBridgeToolResultToSdk(toolFailure("Nope"));

    expect(result).toMatchObject({
      textResultForLlm: "Nope",
      resultType: "failure",
      error: "Nope",
    });
  });

  it("prefers Bridge content contract text over SDK-shaped fields", () => {
    const result = convertBridgeToolResultToSdk({
      ...toolFailure("Restart pending"),
      content: [{
        type: "text",
        text: "Restart is pending.\nBridge tool contract: {\"terminal\":true,\"nextAction\":\"respond\"}.",
      }],
    });

    expect(result).toMatchObject({
      textResultForLlm: "Restart is pending.\nBridge tool contract: {\"terminal\":true,\"nextAction\":\"respond\"}.",
      resultType: "success",
    });
  });

  it("converts MCP error results into SDK failure results with an error message", () => {
    const result = convertBridgeToolResultToSdk({
      isError: true,
      content: [{ type: "text", text: "MCP failed" }],
    });

    expect(result).toMatchObject({
      textResultForLlm: "MCP failed",
      resultType: "failure",
      error: "MCP failed",
    });
  });

  it("converts image results into SDK binary results", () => {
    const result = convertBridgeToolResultToSdk({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });

    expect(result).toMatchObject({
      textResultForLlm: "",
      resultType: "success",
      binaryResultsForLlm: [
        {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      ],
    });
  });
});
