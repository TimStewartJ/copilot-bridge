import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "../../api";
import { ServerCard } from "./ServerCard";
import { getNextTagMcpServerIds, TagMcpServerOption } from "./TagsSection";
import { summarizeMcpServerConfig } from "./mcp-display";

describe("summarizeMcpServerConfig", () => {
  it("summarizes local server command and args", () => {
    expect(summarizeMcpServerConfig({ command: "npx", args: ["-y", "@example/mcp"] })).toBe(
      "local: npx -y @example/mcp",
    );
  });

  it("summarizes remote server transports", () => {
    expect(summarizeMcpServerConfig({ type: "http", url: "https://example.com/mcp" })).toBe(
      "http: https://example.com/mcp",
    );
    expect(summarizeMcpServerConfig({ type: "sse", url: "https://example.com/sse" })).toBe(
      "sse: https://example.com/sse",
    );
  });
});

describe("tag MCP selection UI", () => {
  it("deduplicates selected registry server IDs while preserving order", () => {
    expect(getNextTagMcpServerIds(["alpha"], "beta", true)).toEqual(["alpha", "beta"]);
    expect(getNextTagMcpServerIds(["alpha"], "alpha", true)).toEqual(["alpha"]);
    expect(getNextTagMcpServerIds(["alpha", "beta"], "alpha", false)).toEqual(["beta"]);
  });

  it("renders registered server identity, default badge, and selected state", () => {
    const server: McpServer = {
      id: "server-linear",
      name: "linear",
      config: { type: "http", url: "https://linear.example/mcp" },
      enabledByDefault: true,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(createElement(TagMcpServerOption, {
      server,
      checked: true,
      disabled: true,
      onChange: vi.fn(),
    }));
    const text = html.replace(/<!-- -->/g, "");

    expect(text).toContain("linear");
    expect(text).toContain("default");
    expect(text).toContain("http: https://linear.example/mcp");
    expect(html).toMatch(/<input[^>]*checked/);
    expect(html).toMatch(/<input[^>]*disabled/);
  });
});

describe("ServerCard", () => {
  it("explains enabled-by-default registry servers", () => {
    const html = renderToStaticMarkup(createElement(ServerCard, {
      name: "github",
      config: { type: "http", url: "https://example.com/mcp" },
      enabledByDefault: true,
      onToggleEnabledByDefault: vi.fn(),
      onEdit: vi.fn(),
      onRemove: vi.fn(),
    }));

    expect(html).toContain("Enabled by default");
    expect(html).toContain("Attach this server to every session.");
  });
});
