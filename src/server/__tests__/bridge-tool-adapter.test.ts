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
  it("passes the cancellation signal through the native SDK path", async () => {
    const controller = new AbortController();
    let seen: BridgeToolInvocation | undefined;
    const tool = defineBridgeTool("cancel_probe", {
      handler: (_args, invocation) => { seen = invocation; return "ok"; },
    });
    const [native] = createNativeBridgeTools([tool]);
    const result = await native!.handler!({}, {
      sessionId: "session-1", toolCallId: "cancel-1", toolName: "cancel_probe",
      arguments: {}, signal: controller.signal,
    });
    expect(seen?.signal).toBe(controller.signal);
    expect(result).toMatchObject({ resultType: "success", textResultForLlm: "ok" });
  });

  it("passes the invoking session id through", async () => {
    let seen: BridgeToolInvocation | undefined;
    const tool = defineBridgeTool("probe", { handler: async (_args, invocation) => { seen = invocation; return "ok"; } });

    await tool.handler({}, extra({ sessionId: "session-a", requestId: 42 }));

    expect(seen?.sessionId).toBe("session-a");
    expect(seen?.toolCallId).toBe("42");
    expect(seen?.toolName).toBe("probe");
  });

  it("normalizes missing SDK invocation identities without inventing a session", async () => {
    let seen: BridgeToolInvocation | undefined;
    const tool = defineBridgeTool("probe", { handler: async (_args, invocation) => { seen = invocation; return "ok"; } });

    await expect(tool.handler({}, extra({ sessionId: undefined, requestId: undefined }))).resolves.toBe("ok");
    expect(seen?.sessionId).toBeUndefined();

    expect(seen?.toolCallId).toBe("");

    await tool.handler({}, extra({ sessionId: "   " }));
    expect(seen?.sessionId).toBeUndefined();
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

describe("native tool catalog", () => {
  it("keeps chat actions session-only and omits dashboard publishing tools", () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerAllBridgeTools(server, ctx);
    const tools = new Map(server.getToolDefinitions("all").map((tool) => [tool.name, tool]));

    const publishContent = (tools.get("publish_visual")!.inputSchema as any).properties.content;
    expect(publishContent.anyOf).toEqual(expect.any(Array));
    for (const retired of ["feed_save", "decision_save", "alert_save", "event_save", "focus_protection_current"]) expect(tools.has(retired)).toBe(false);
    for (const native of ["task_update_momentum", "action_add", "schedule_create", "docs_read"]) expect(tools.has(native)).toBe(true);

    const global = new Set(server.getToolNames("global"));
    expect(server.getToolNames("session").filter((name) => !global.has(name))).toEqual(expect.arrayContaining([
      "session_start", "session_send", "agent_stop", "defer_create", "send_attachment", "publish_visual",
    ]));
  });
});
