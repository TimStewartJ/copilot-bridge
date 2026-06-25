import { describe, expect, it } from "vitest";

import type { AppContext } from "../../app-context.js";
import {
  BridgeToolsMcpServer,
  normalizeToolResult,
} from "../index.js";

function makeRegistry(): BridgeToolsMcpServer {
  const server = new BridgeToolsMcpServer({} as AppContext);
  server.registerTool({
    name: "global_tool",
    description: "Global Bridge tool",
    inputSchema: { type: "object", properties: {} },
    handler: async () => "global",
  });
  server.registerTool({
    name: "session_tool",
    description: "Session-scoped Bridge tool",
    inputSchema: { type: "object", properties: {} },
    scope: "session",
    handler: async () => "session",
  });
  server.registerTool({
    name: "both_tool",
    description: "Bridge tool visible on every scope",
    inputSchema: { type: "object", properties: {} },
    scope: "both",
    handler: async () => "both",
  });
  return server;
}

describe("BridgeToolsMcpServer registry", () => {
  it("registers tools and lists names with the default global scope", () => {
    const server = makeRegistry();
    expect(server.getToolNames().sort()).toEqual(["both_tool", "global_tool"]);
  });

  it("rejects duplicate tool registration", () => {
    const server = makeRegistry();
    expect(() =>
      server.registerTool({
        name: "global_tool",
        inputSchema: { type: "object", properties: {} },
        handler: async () => "dupe",
      }),
    ).toThrow(/already registered/);
  });

  it("filters definitions by scope and exposes everything for the native surface", () => {
    const server = makeRegistry();
    expect(server.getToolDefinitions("global").map((tool) => tool.name).sort()).toEqual([
      "both_tool",
      "global_tool",
    ]);
    expect(server.getToolDefinitions("session").map((tool) => tool.name).sort()).toEqual([
      "both_tool",
      "session_tool",
    ]);
    expect(server.getToolDefinitions("all").map((tool) => tool.name).sort()).toEqual([
      "both_tool",
      "global_tool",
      "session_tool",
    ]);
  });

  it("no longer exposes any MCP socket/stdio transport surface", () => {
    const server = makeRegistry() as unknown as Record<string, unknown>;
    for (const method of ["listen", "listenForSession", "closeSessionEndpoint", "close"]) {
      expect(server[method]).toBeUndefined();
    }
  });
});

describe("normalizeToolResult", () => {
  it("wraps plain strings as text content", () => {
    expect(normalizeToolResult("hello")).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("marks legacy Bridge failure results as errors", () => {
    const result = normalizeToolResult({
      textResultForLlm: "legacy failure text",
      resultType: "failure",
      error: "legacy failure text",
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "legacy failure text" }],
    });
  });

  it("relabels image content whose declared MIME contradicts its magic bytes", () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const data = pngBytes.toString("base64");
    const result = normalizeToolResult({ type: "image", data, mimeType: "image/jpeg" });
    expect(result).toEqual({ content: [{ type: "image", data, mimeType: "image/png" }] });
  });
});
