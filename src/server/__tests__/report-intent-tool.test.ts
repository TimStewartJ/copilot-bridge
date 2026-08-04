import { describe, expect, it } from "vitest";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { registerReportIntentTool } from "../tools/report-intent-tool.js";
import { createTestApp } from "./test-app.js";
import type { AppContext } from "../app-context.js";

function makeHandlerExtra(sessionId: string | undefined = "session-a") {
  return {
    sessionId,
    requestId: "req-1",
    signal: new AbortController().signal,
  } as any;
}

const SESSIONLESS_EXTRA = { sessionId: undefined, requestId: "req-1", signal: new AbortController().signal } as any;

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

function getTool(ctx: AppContext) {
  const server = new BridgeToolsMcpServer(ctx);
  registerReportIntentTool(server, ctx);
  return (server as any).tools.get("report_intent");
}

describe("registerReportIntentTool (MCP)", () => {
  it("returns isError for a blank intent", async () => {
    const { ctx } = createTestApp();
    const result = await getTool(ctx).handler({ intent: "   " }, makeHandlerExtra());
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Intent must not be blank" }],
    });
  });

  it("rejects a missing intent through the declared schema", async () => {
    const { ctx } = createTestApp();
    const result = await getTool(ctx).handler({}, makeHandlerExtra());
    expect(String(result.textResultForLlm)).toContain("missing required property: intent");
  });

  it("emits the intent only on the invoking session", async () => {
    const ctx = createAppWithActiveSessions(["session-a", "session-b"]);
    const busA = ctx.eventBusRegistry.getOrCreateBus("session-a");
    const busB = ctx.eventBusRegistry.getOrCreateBus("session-b");

    const globalEvents: unknown[] = [];
    ctx.globalBus.subscribe((e) => globalEvents.push(e));

    await getTool(ctx).handler({ intent: "Exploring codebase" }, makeHandlerExtra("session-a"));

    expect(busA.getSnapshot().intentText).toBe("Exploring codebase");
    expect(busB.getSnapshot().intentText).toBeFalsy();
    expect(globalEvents.filter((event: any) => event.type === "session:intent")).toEqual([
      { type: "session:intent", sessionId: "session-a", intent: "Exploring codebase" },
    ]);
  });

  it("keeps concurrent sessions isolated from each other", async () => {
    const ctx = createAppWithActiveSessions(["session-a", "session-b"]);
    const busA = ctx.eventBusRegistry.getOrCreateBus("session-a");
    const busB = ctx.eventBusRegistry.getOrCreateBus("session-b");
    const tool = getTool(ctx);

    await tool.handler({ intent: "Running checks" }, makeHandlerExtra("session-a"));
    await tool.handler({ intent: "Reading docs" }, makeHandlerExtra("session-b"));

    expect(busA.getSnapshot().intentText).toBe("Running checks");
    expect(busB.getSnapshot().intentText).toBe("Reading docs");
  });

  it("fails when the invocation carries no session id", async () => {
    const ctx = createAppWithActiveSessions(["session-a"]);
    const bus = ctx.eventBusRegistry.getOrCreateBus("session-a");

    const result: any = await getTool(ctx).handler({ intent: "Exploring" }, SESSIONLESS_EXTRA);

    expect(String(result.textResultForLlm)).toContain("report_intent requires an invoking session");
    expect(bus.getSnapshot().intentText).toBeFalsy();
  });

  it("succeeds without an existing bus for the invoking session", async () => {
    const { ctx } = createTestApp();
    const result = await getTool(ctx).handler({ intent: "Running checks" }, makeHandlerExtra("session-z"));
    expect(result).toMatchObject({ content: [{ type: "text", text: "Intent logged" }] });
    expect(result.isError).toBeFalsy();
  });

  it("trims whitespace from intent before emitting", async () => {
    const ctx = createAppWithActiveSessions(["session-c"]);
    const bus = ctx.eventBusRegistry.getOrCreateBus("session-c");

    await getTool(ctx).handler({ intent: "  writing tests  " }, makeHandlerExtra("session-c"));

    expect(bus.getSnapshot().intentText).toBe("writing tests");
  });
});
