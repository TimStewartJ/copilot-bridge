import { describe, expect, it, vi } from "vitest";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { registerReportIntentTool } from "../tools/report-intent-tool.js";
import { createTestApp } from "./helpers.js";
import { createEventBusRegistry } from "../event-bus.js";
import type { AppContext } from "../app-context.js";

function makeHandlerExtra() {
  return {
    sessionId: "mcp-session-1",
    requestId: "req-1",
    signal: new AbortController().signal,
  } as any;
}

function createAppWithActiveSessions(sessionIds: string[]): AppContext {
  const { ctx } = createTestApp();
  const activity = sessionIds.map((id) => ({
    id,
    state: "busy" as const,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    elapsedMs: 0,
    staleMs: 0,
  }));
  const sessionManager = {
    ...ctx.sessionManager,
    getSessionActivity: () => activity,
  };
  return { ...ctx, sessionManager } as AppContext;
}

describe("registerReportIntentTool (MCP)", () => {
  it("registers report_intent in the MCP server", () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerReportIntentTool(server, ctx);
    expect(server.getToolNames()).toContain("report_intent");
  });

  it("returns isError for blank intent", async () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerReportIntentTool(server, ctx);

    const tool = (server as any).tools.get("report_intent");
    const result = await tool.handler({ intent: "   " }, makeHandlerExtra());
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Intent must not be blank" }],
    });
  });

  it("returns isError for missing intent", async () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerReportIntentTool(server, ctx);

    const tool = (server as any).tools.get("report_intent");
    const result = await tool.handler({}, makeHandlerExtra());
    expect(result).toMatchObject({ isError: true });
  });

  it("returns success text for valid intent when no sessions are active", async () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerReportIntentTool(server, ctx);

    const tool = (server as any).tools.get("report_intent");
    const result = await tool.handler({ intent: "Running checks" }, makeHandlerExtra());
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Intent logged" }],
    });
    expect(result.isError).toBeFalsy();
  });

  it("emits intent on event bus and global bus for each active session", async () => {
    const ctx = createAppWithActiveSessions(["session-a", "session-b"]);
    const server = new BridgeToolsMcpServer(ctx);
    registerReportIntentTool(server, ctx);

    // Pre-create event buses so we can observe them
    const busA = ctx.eventBusRegistry.getOrCreateBus("session-a");
    const busB = ctx.eventBusRegistry.getOrCreateBus("session-b");

    const globalEvents: unknown[] = [];
    ctx.globalBus.subscribe((e) => globalEvents.push(e));

    const tool = (server as any).tools.get("report_intent");
    await tool.handler({ intent: "Exploring codebase" }, makeHandlerExtra());

    expect(busA.getSnapshot().intentText).toBe("Exploring codebase");
    expect(busB.getSnapshot().intentText).toBe("Exploring codebase");
    expect(globalEvents).toContainEqual({ type: "session:intent", sessionId: "session-a", intent: "Exploring codebase" });
    expect(globalEvents).toContainEqual({ type: "session:intent", sessionId: "session-b", intent: "Exploring codebase" });
  });

  it("trims whitespace from intent before emitting", async () => {
    const ctx = createAppWithActiveSessions(["session-c"]);
    const server = new BridgeToolsMcpServer(ctx);
    registerReportIntentTool(server, ctx);

    const bus = ctx.eventBusRegistry.getOrCreateBus("session-c");
    const tool = (server as any).tools.get("report_intent");
    await tool.handler({ intent: "  writing tests  " }, makeHandlerExtra());

    expect(bus.getSnapshot().intentText).toBe("writing tests");
  });
});
