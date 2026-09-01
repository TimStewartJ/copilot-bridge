import { describe, expect, it } from "vitest";
import { defineBridgeTool, defineSessionBridgeTool } from "../agent-tools-mcp/adapter.js";
import { registerAllBridgeTools } from "../agent-tools-mcp/register.js";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { createNativeBridgeTools } from "../bridge-native-tools.js";
import { createTestApp } from "./test-app.js";
import { testPath } from "./test-paths.js";
import type { BridgeToolInvocation } from "../agent-tools-mcp/adapter.js";

function extra(overrides: Record<string, unknown> = {}) {
  return { sessionId: "session-1", requestId: "req-1", ...overrides } as any;
}

function failureText(result: unknown): string {
  return String((result as { textResultForLlm?: string }).textResultForLlm ?? "");
}

describe("defineBridgeTool invocation identity", () => {
  it("passes the invoking session id through", async () => {
    let seen: BridgeToolInvocation | undefined;
    const tool = defineBridgeTool("probe", { handler: async (_args, invocation) => { seen = invocation; return "ok"; } });

    await tool.handler({}, extra({ sessionId: "session-a", requestId: 42 }));

    expect(seen?.sessionId).toBe("session-a");
    expect(seen?.toolCallId).toBe("42");
    expect(seen?.toolName).toBe("probe");
  });

  it("reports a missing session as undefined rather than an empty string", async () => {
    let seen: BridgeToolInvocation | undefined;
    const tool = defineBridgeTool("probe", { handler: async (_args, invocation) => { seen = invocation; return "ok"; } });

    await tool.handler({}, extra({ sessionId: undefined }));
    expect(seen?.sessionId).toBeUndefined();

    await tool.handler({}, extra({ sessionId: "   " }));
    expect(seen?.sessionId).toBeUndefined();
  });

  it("never yields an empty toolCallId string of 'undefined'", async () => {
    let seen: BridgeToolInvocation | undefined;
    const tool = defineBridgeTool("probe", { handler: async (_args, invocation) => { seen = invocation; return "ok"; } });

    await tool.handler({}, extra({ requestId: undefined }));
    expect(seen?.toolCallId).toBe("");
  });

  it("fails session-scoped tools invoked without a session", async () => {
    let ran = false;
    const tool = defineBridgeTool("session_probe", {
      scope: "session",
      handler: async () => { ran = true; return "ok"; },
    });

    const result = await tool.handler({}, extra({ sessionId: undefined }));

    expect(ran).toBe(false);
    expect(failureText(result)).toContain("session_probe requires an invoking session");
  });

  it("allows global tools without a session", async () => {
    const tool = defineBridgeTool("global_probe", { handler: async () => "ok" });
    await expect(tool.handler({}, extra({ sessionId: undefined }))).resolves.toBe("ok");
  });
});

describe("defineBridgeTool schema enforcement", () => {
  const tool = defineBridgeTool("typed_probe", {
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        count: { type: "integer", minimum: 1 },
        mode: { type: "string", enum: ["a", "b"] },
      },
      required: ["id"],
    },
    handler: async (args: any) => ({ received: args }),
  });

  it("rejects arguments that violate the declared schema before the handler runs", async () => {
    let ran = false;
    const guarded = defineBridgeTool("guarded", {
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async () => { ran = true; return "ok"; },
    });

    const result = await guarded.handler({}, extra());

    expect(ran).toBe(false);
    expect(failureText(result)).toContain("Invalid arguments for guarded");
    expect(failureText(result)).toContain("missing required property: id");
  });

  it("rejects wrong types, out-of-range integers and bad enums", async () => {
    expect(failureText(await tool.handler({ id: 1 }, extra()))).toContain("id must be string");
    expect(failureText(await tool.handler({ id: "x", count: 0 }, extra()))).toContain("count must be >= 1");
    expect(failureText(await tool.handler({ id: "x", count: 1.5 }, extra()))).toContain("count must be integer");
    expect(failureText(await tool.handler({ id: "x", mode: "c" }, extra()))).toContain("mode must be one of");
  });

  it("passes valid arguments through unchanged", async () => {
    const result = await tool.handler({ id: "x", count: 3, mode: "b" }, extra());
    expect(result).toEqual({ received: { id: "x", count: 3, mode: "b" } });
  });

  it("enforces the same contract on the SDK native tool path", async () => {
    const [native] = createNativeBridgeTools([tool]);
    const result = await native.handler!({ id: 1 } as any, {
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "typed_probe",
      arguments: {},
    } as any);

    expect(String((result as any).textResultForLlm)).toContain("id must be string");
  });
});

describe("defineSessionBridgeTool", () => {
  it("marks the tool session-scoped and guarantees a session id to the handler", async () => {
    let seen: string | undefined;
    const tool = defineSessionBridgeTool("session_probe", {
      handler: async (_args, invocation) => { seen = invocation.sessionId; return "ok"; },
    });

    expect(tool.scope).toBe("session");
    await tool.handler({}, extra({ sessionId: "session-a" }));
    expect(seen).toBe("session-a");
  });

  it("rejects a sessionless call before the handler runs", async () => {
    let ran = false;
    const tool = defineSessionBridgeTool("session_probe", { handler: async () => { ran = true; return "ok"; } });

    const result = await tool.handler({}, extra({ sessionId: undefined }));

    expect(ran).toBe(false);
    expect(failureText(result)).toContain("session_probe requires an invoking session");
  });
});

describe("session-scoped tool registration", () => {
  it("every session-scoped tool goes through the shared guard", () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerAllBridgeTools(server, ctx);

    const sessionTools = server.getToolDefinitions("all").filter((tool) => tool.scope === "session");
    expect(sessionTools.length).toBeGreaterThan(5);

    for (const tool of sessionTools) {
      expect(tool.scope).toBe("session");
    }
  });
});

describe("registry guards against unvalidated tools", () => {
  it("rejects a tool whose handler was not built by defineBridgeTool", () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);

    expect(() => server.registerTool({
      name: "raw_tool",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "ok",
    })).toThrow(/must be built with defineBridgeTool/);
  });

  it("rejects a tool whose validating handler was patched out after construction", () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    const tool = defineBridgeTool("patched_tool", { handler: async () => "ok" });

    expect(() => server.registerTool({ ...tool, handler: async () => "bypassed" }))
      .toThrow(/must be built with defineBridgeTool/);
  });

  it("validates arguments for every registered tool, including staging tools", async () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerAllBridgeTools(server, ctx);

    const stagingDeploy = server.getToolDefinitions("all").find((tool) => tool.name === "staging_deploy");
    if (stagingDeploy) {
      const result = await stagingDeploy.handler({ stagingDir: testPath("staging", "worktree") }, extra());
      expect(failureText(result)).toContain("missing required property: message");
    }
  });
});

describe("visual payload schemas", () => {
  it("declare the same content shapes on publish_visual and feed_save", () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerAllBridgeTools(server, ctx);
    const tools = new Map(server.getToolDefinitions("all").map((tool) => [tool.name, tool]));

    const publishContent = (tools.get("publish_visual")!.inputSchema as any).properties.content;
    const feedVisual = (tools.get("feed_save")!.inputSchema as any).properties.visual;
    const feedContent = feedVisual.anyOf[0].properties.content;

    expect(feedContent.anyOf).toEqual(publishContent.anyOf);
    expect(feedVisual.anyOf[0].properties.kind.enum)
      .toEqual((tools.get("publish_visual")!.inputSchema as any).properties.kind.enum);
  });
});
