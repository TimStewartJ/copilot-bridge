import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";
import McpStatusBar from "./McpStatusBar";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("McpStatusBar status ownership", () => {
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
});
