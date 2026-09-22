import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";
import McpStatusBar from "./McpStatusBar";
import type { SessionContextResponse } from "../../shared/session-context";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("McpStatusBar status ownership", () => {
  it("keeps a connected transport separate from permission failure guidance", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [{ name: "kusto", status: "connected", observedAt: new Date().toISOString(), provenance: "probe" }],
        statusState: "ready",
        chatEntries: [{ type: "tool", toolCall: { toolCallId: "query", name: "kusto-query", success: false, result: "403 Forbidden" } }],
      }));
      const button = findAllByTag(harness.dom.container, "BUTTON")[0];
      expect(button.textContent).toContain("1 tool issue");
      await harness.act(async () => getReactProps(button)?.onClick?.());
      expect(harness.dom.container.textContent).toContain("1/1 connected");
      expect(harness.dom.container.textContent).toContain("permission");
      expect(harness.dom.container.textContent).toContain("403 is not evidence of expired authentication");
      expect(harness.dom.container.textContent).toContain("Tool permissions are separate");
      expect(findAllByTag(harness.dom.container, "SPAN").some((element) =>
        getReactProps(element)?.title?.includes("; probe;"))).toBe(true);
      expect(harness.dom.container.textContent).not.toContain("Start sign-in");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps pending connections visible and refreshable after tools are loaded", async () => {
    const harness = await createReactDomHarness();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [{ name: "demo", status: "pending" }],
        toolReadiness: { state: "ready", startedAt: "2026-09-22T18:17:27Z", completedAt: "2026-09-22T18:17:28Z" },
        statusState: "ready", onRefresh,
      }));
      await harness.act(async () => getReactProps(findAllByTag(harness.dom.container, "BUTTON")[0])?.onClick?.());
      expect(harness.dom.container.textContent).toContain("Tool definitions loaded");
      expect(harness.dom.container.textContent).toContain("Connecting...");
      expect(harness.dom.container.textContent).not.toContain("2026-09-22");
      expect(getReactProps(findAllByTag(harness.dom.container, "DETAILS")[0])?.open).toBe(true);
      const refresh = findAllByTag(harness.dom.container, "BUTTON").find((button) => button.textContent === "Refresh");
      await harness.act(async () => getReactProps(refresh)?.onClick?.());
      expect(onRefresh).toHaveBeenCalledOnce();
    } finally { await harness.cleanup(); }
  });

  it("stays hidden for a confirmed empty configuration with no context signal", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [],
        statusState: "ready",
      }));
      expect(harness.dom.container.textContent).toBe("");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the chat identity and plan action visible even with nothing to report", async () => {
    const harness = await createReactDomHarness();
    const onPlan = vi.fn();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [],
        statusState: "ready",
        leading: createElement("span", null, "Chat title / Model"),
        actions: createElement("button", { onClick: onPlan }, "Plan"),
      }));
      expect(harness.dom.container.textContent).toBe("Chat title / ModelPlan");
      const buttons = findAllByTag(harness.dom.container, "BUTTON");
      expect(buttons).toHaveLength(1);
      await harness.act(async () => getReactProps(buttons[0])?.onClick?.());
      expect(onPlan).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });

  it("opens session details without making the identity or plan part of its button", async () => {
    const harness = await createReactDomHarness();
    const onPlan = vi.fn();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [],
        statusState: "ready",
        sessionCostUsd: 0.025,
        leading: createElement("span", null, "Chat title / Model"),
        actions: createElement("button", { onClick: onPlan }, "Plan"),
      }));
      const toggle = findAllByTag(harness.dom.container, "BUTTON")
        .find((button) => getReactProps(button)?.["aria-label"] === "Session details");
      expect(toggle?.textContent).toContain("Cost $0.03");
      expect(toggle?.textContent).not.toContain("Chat title");
      expect(toggle?.textContent).not.toContain("Plan");
      await harness.act(async () => getReactProps(toggle)?.onClick?.());
      expect(getReactProps(toggle)?.["aria-expanded"]).toBe(true);
      expect(harness.dom.container.textContent).toContain("Session cost");
      expect(onPlan).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("renders accessible loading feedback", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [],
        statusState: "loading",
      }));
      expect(harness.dom.container.textContent).toContain("MCP loading");
      const button = findAllByTag(harness.dom.container, "BUTTON")[0];
      await harness.act(async () => getReactProps(button)?.onClick?.());
      const status = findAllByTag(harness.dom.container, "P")
        .find((element) => getReactProps(element)?.role === "status");
      expect(status?.textContent).toContain("Loading servers");
      const panel = findAllByTag(harness.dom.container, "DIV")
        .find((element) => getReactProps(element)?.["data-session-details"] === "");
      expect(panel).toBeDefined();
      expect(getReactProps(panel)?.className).toContain("w-full");
      expect(getReactProps(panel)?.className).not.toMatch(/max-w-/);
    } finally {
      await harness.cleanup();
    }
  });

  it("renders failed-fetch feedback and retries", async () => {
    const harness = await createReactDomHarness();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [],
        statusState: "error",
        statusError: "MCP status offline",
        onRefresh,
      }));
      const buttons = findAllByTag(harness.dom.container, "BUTTON");
      await harness.act(async () => getReactProps(buttons[0])?.onClick?.());
      const retry = findAllByTag(harness.dom.container, "BUTTON")
        .find((button) => button.textContent === "Retry");
      const alert = findAllByTag(harness.dom.container, "DIV")
        .find((element) => getReactProps(element)?.role === "alert");
      expect(alert?.textContent).toContain("MCP status offline");
      await harness.act(async () => getReactProps(retry)?.onClick?.());
      expect(onRefresh).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });

  it("retains known servers while marking a failed refresh stale", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [{ name: "demo", status: "connected" }],
        statusState: "stale",
        statusError: "Refresh failed",
      }));
      expect(harness.dom.container.textContent).toContain("MCP 1/1");
      expect(harness.dom.container.textContent).toContain("stale");
    } finally {
      await harness.cleanup();
    }
  });

  it("shows the live session cost alongside MCP and context status", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [],
        statusState: "ready",
        sessionCostUsd: 0.025,
      }));
      expect(harness.dom.container.textContent).toBe("Cost $0.03");
    } finally {
      await harness.cleanup();
    }
  });

  it("labels a successful SDK response with no cost as not recorded, rather than hiding or zeroing it", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, { servers: [], statusState: "ready", sessionCostUsd: null }));
      expect(harness.dom.container.textContent).toBe("Cost Not recorded");
      expect(harness.dom.container.textContent).not.toContain("$0.00");
    } finally { await harness.cleanup(); }
  });

  it("keeps a small positive session cost visible instead of showing a free run", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, { servers: [], statusState: "ready", sessionCostUsd: 0.0025 }));
      expect(harness.dom.container.textContent).toBe("Cost $0.0025");
    } finally { await harness.cleanup(); }
  });

  it("surfaces failed cost reads without fabricating a zero and keeps cached readings marked", async () => {
    const harness = await createReactDomHarness();
    try {
      const props = { servers: [], statusState: "ready" as const, sessionCostError: "Metering offline" };
      await harness.render(createElement(McpStatusBar, props));
      expect(harness.dom.container.textContent).toContain("Cost unavailable");
      expect(harness.dom.container.textContent).not.toContain("$0.00");
      await harness.act(async () => getReactProps(findAllByTag(harness.dom.container, "BUTTON")[0])?.onClick?.());
      expect(harness.dom.container.textContent).toContain("Cost refresh failed: Metering offline");
      await harness.render(createElement(McpStatusBar, { ...props, sessionCostUsd: 0.025 }));
      expect(harness.dom.container.textContent).toContain("$0.03");
      expect(harness.dom.container.textContent).toContain("Showing the previous reading.");
    } finally { await harness.cleanup(); }
  });

  it("tucks healthy servers away but opens failures and keeps sign-in actionable", async () => {
    const harness = await createReactDomHarness();
    const onAuthenticate = vi.fn().mockResolvedValue({ authorizationUrl: "https://example.com/login" });
    await harness.render(createElement(McpStatusBar, {
      servers: [{ name: "demo", status: "connected" }],
      statusState: "ready",
    }));
    await harness.act(async () => getReactProps(findAllByTag(harness.dom.container, "BUTTON")[0])?.onClick());
    expect(getReactProps(findAllByTag(harness.dom.container, "DETAILS")[0])?.open).toBe(false);
    await harness.render(createElement(McpStatusBar, {
      servers: [{ name: "demo", status: "needs-auth" }, { name: "offline", status: "failed", error: "Connection refused" }],
      statusState: "ready",
      onAuthenticate,
    }));
    expect(harness.dom.container.textContent).toContain("1 failed, 1 sign-in");
    expect(getReactProps(findAllByTag(harness.dom.container, "DETAILS")[0])?.open).toBe(true);
    const signIn = findAllByTag(harness.dom.container, "BUTTON").find((button) => button.textContent === "Start sign-in");
    await harness.act(async () => getReactProps(signIn)?.onClick());
    expect(onAuthenticate).toHaveBeenCalledWith("demo", { forceReauth: false });
    expect(getReactProps(findAllByTag(harness.dom.container, "A")[0])?.href).toBe("https://example.com/login");
  });

  it("keeps live context and usage details without a graph, turn inspector or event list", async () => {
    const harness = await createReactDomHarness();
    const context: SessionContextResponse = {
      provider: "copilot",
      summary: null,
      capabilities: { contextWindow: "exact", modelUsage: "exact", compaction: "marker", truncation: "unavailable" },
      turns: [{
        sessionId: "session", bridgeTurnId: "turn", provider: "copilot", providerSessionId: null,
        providerTurnId: null, attribution: "turn", startedAt: null, endedAt: null, latestEventAt: null, model: null,
      }],
      events: [{
        id: 1, sessionId: "session", bridgeTurnId: "turn", provider: "copilot", providerSessionId: null,
        providerTurnId: null, providerEventId: null, attribution: "turn", type: "compaction",
        occurredAt: "2026-09-22T00:00:00Z", model: null, contextWindow: 1000, tokensUsed: 400,
        tokensRemaining: 600, usageRatio: 0.4, modelUsage: null, metadata: null,
      }],
    };
    const summary = {
      sessionId: "session", provider: "copilot", providerSessionId: null, updatedAt: "2026-09-22T00:00:00Z",
      currentModel: "test-model", latestBridgeTurnId: "turn", latestSnapshotAt: null,
      contextWindow: 1000, tokensUsed: 400, tokensRemaining: 600, usageRatio: 0.4,
      modelUsage: { inputTokens: 800, outputTokens: 120, reasoningTokens: 20, cacheReadTokens: 200, requests: 2 },
      snapshotCount: 1, compactionCount: 1, truncationCount: 0, shutdownCount: 0,
    };
    await harness.render(createElement(McpStatusBar, {
      servers: [{ name: "demo", status: "connected" }], statusState: "ready", sessionCostUsd: 0.02,
      context: { ...context, summary }, liveContextSummary: { ...summary, tokensUsed: 500, tokensRemaining: 500, usageRatio: 0.5 },
    }));
    const toggle = findAllByTag(harness.dom.container, "BUTTON")[0];
    expect(toggle.textContent).toContain("Context 50%");
    await harness.act(async () => getReactProps(toggle)?.onClick?.());
    const text = harness.dom.container.textContent;
    expect(text).toContain("500 / 1,000 tokens");
    expect(text).toContain("500 tokens left");
    expect(text).toContain("Usage details");
    expect(text).toContain("included in output");
    expect(text).toContain("Session cost");
    expect(text).toContain("MCP servers");
    expect(text).not.toContain("Context history");
    expect(text).not.toContain("Inspect turn");
    expect(text).not.toContain("Events (");
    expect(findAllByTag(harness.dom.container, "SELECT")).toHaveLength(0);
    expect(findAllByTag(harness.dom.container, "TABLE")).toHaveLength(0);
    expect(findAllByTag(harness.dom.container, "SVG").some(node => getReactProps(node)?.role === "group")).toBe(false);
    await harness.act(async () => getReactProps(toggle)?.onClick?.());
    expect(harness.dom.container.textContent).not.toContain("Usage details");
  });
});
