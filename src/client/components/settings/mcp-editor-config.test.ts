import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../api";
import { withUneditedMcpServerFields } from "./mcp-editor-config";

describe("withUneditedMcpServerFields", () => {
  it("keeps stored fields the editor does not show", () => {
    const stored = {
      command: "node",
      args: ["old.js"],
      workingDirectory: "workspace",
      deferTools: "never",
    };

    expect(withUneditedMcpServerFields(stored, {
      command: "node",
      args: ["new.js"],
      executionScope: "auto",
    })).toEqual({
      command: "node",
      args: ["new.js"],
      executionScope: "auto",
      workingDirectory: "workspace",
      deferTools: "never",
    });
  });

  it("lets the form clear the fields it owns", () => {
    const stored: McpServerConfig = {
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "abc" },
      tools: ["lookup"],
      executionScope: "session",
    };

    expect(withUneditedMcpServerFields(stored, {
      command: "node",
      args: ["server.js"],
      executionScope: "auto",
    })).toEqual({
      command: "node",
      args: ["server.js"],
      executionScope: "auto",
    });
  });

  it("keeps OAuth settings when a remote server stays remote", () => {
    const stored = {
      type: "http" as const,
      url: "https://old.example/mcp",
      headers: { Authorization: "old" },
      oauthClientId: "client",
      auth: { redirectPort: 8123 },
    };

    expect(withUneditedMcpServerFields(stored, { type: "http", url: "https://new.example/mcp" })).toEqual({
      type: "http",
      url: "https://new.example/mcp",
      oauthClientId: "client",
      auth: { redirectPort: 8123 },
    });
  });

  it("drops fields that only apply to the previous transport", () => {
    const remote = {
      type: "http" as const,
      url: "https://example.com/mcp",
      oauthClientId: "client",
      deferTools: "never",
    };
    expect(withUneditedMcpServerFields(remote, { command: "node", args: [] })).toEqual({
      command: "node",
      args: [],
      deferTools: "never",
    });

    const local = { command: "node", args: [], workingDirectory: "workspace", deferTools: "never" };
    expect(withUneditedMcpServerFields(local, { type: "sse", url: "https://example.com/sse" })).toEqual({
      type: "sse",
      url: "https://example.com/sse",
      deferTools: "never",
    });
  });
});
