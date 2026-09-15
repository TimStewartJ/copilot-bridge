import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";
import McpStatusBar from "./McpStatusBar";

describe("session details tool readiness", () => {
  it.each(["initializing", "failed", "ready"] as const)("keeps %s tool readiness independent of connected transport", async (state) => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [{ name: "demo", status: "connected" }],
        statusState: "ready",
        toolReadiness: { state, startedAt: "2026-09-15T17:00:00Z", ...(state === "failed" ? { error: "metadata validation failed" } : {}) },
      }));
      const button = findAllByTag(harness.dom.container, "BUTTON")[0];
      await harness.act(async () => getReactProps(button)?.onClick?.());
      const text = harness.dom.container.textContent;
      expect(text).toContain("1/1 connected");
      if (state === "initializing") expect(text).toContain("Discovery can take several minutes");
      if (state === "failed") expect(text).toContain("metadata validation failed");
      if (state === "ready") expect(text).toContain("does not prove every capability");
      expect(text).not.toContain("MCP status unavailable");
      expect(text).not.toContain("Start sign-in");
    } finally {
      await harness.cleanup();
    }
  });

  it("never equates an empty connection list with conclusive capability readiness", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(McpStatusBar, {
        servers: [], statusState: "ready",
        toolReadiness: { state: "ready", startedAt: "2026-09-15T17:00:00Z" },
      }));
      await harness.act(async () => getReactProps(findAllByTag(harness.dom.container, "BUTTON")[0])?.onClick?.());
      expect(harness.dom.container.textContent).toContain("No MCP connection observations");
      expect(harness.dom.container.textContent).toContain("does not establish tool capability readiness");
    } finally {
      await harness.cleanup();
    }
  });
});
