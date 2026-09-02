import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "../../api";
import { ServerCard } from "./ServerCard";
import { ServerEditor } from "./ServerEditor";
import { getNextTagMcpServerIds, TagMcpServerOption } from "./TagsSection";
import {
  summarizeMcpServerConfig,
  summarizeMcpServerExecution,
} from "./mcp-display";

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

  it("summarizes requested and effective execution policy", () => {
    expect(summarizeMcpServerExecution({
      command: "agency",
      args: ["mcp", "ado"],
      executionScope: "shared",
    })).toBe("session isolated (shared requested)");
    expect(summarizeMcpServerExecution({
      command: "node",
      args: ["server.js"],
      executionScope: "session",
    })).toBe("session isolated (explicit)");
    expect(summarizeMcpServerExecution({
      type: "http",
      url: "https://example.com/mcp",
    })).toBe("direct");
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

  it("renders execution classification and its reason", () => {
    const html = renderToStaticMarkup(createElement(ServerCard, {
      name: "ado",
      config: {
        command: "agency",
        args: ["mcp", "ado"],
        executionScope: "shared",
      },
      onEdit: vi.fn(),
      onRemove: vi.fn(),
    }));

    expect(html).toContain("session isolated (shared requested)");
    expect(html).toContain("Shared execution is requested");
  });
});

describe("ServerEditor", () => {
  it("offers automatic, shared, and session-isolated execution policies for local servers", () => {
    const html = renderToStaticMarkup(createElement(ServerEditor, {
      name: "ado",
      config: {
        command: "agency",
        args: ["mcp", "ado"],
        executionScope: "auto",
      },
      existingNames: [],
      onSave: vi.fn(),
      onCancel: vi.fn(),
    }));

    expect(html).toContain("Execution policy");
    expect(html).toContain("Automatic (recommended)");
    expect(html).toContain("Shared broker (when available)");
    expect(html).toContain("Session isolated");
    expect(html).toContain("eligible for broker validation");
  });
});
