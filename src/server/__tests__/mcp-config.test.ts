import { describe, expect, it } from "vitest";

import {
  classifyMcpServerExecution,
  isMcpServerConfig,
  toRuntimeMcpServerConfig,
} from "../mcp-config.js";

describe("MCP execution policy", () => {
  it("accepts local execution scopes and keeps them out of runtime config", () => {
    const config = {
      command: "agency",
      args: ["mcp", "ado"],
      executionScope: "shared" as const,
    };

    expect(isMcpServerConfig(config)).toBe(true);
    expect(toRuntimeMcpServerConfig(config)).toEqual({
      command: "agency",
      args: ["mcp", "ado"],
    });
    expect(config.executionScope).toBe("shared");
  });

  it("rejects invalid or remote execution scopes", () => {
    expect(isMcpServerConfig({
      command: "agency",
      args: ["mcp", "ado"],
      executionScope: "global",
    })).toBe(false);
    expect(isMcpServerConfig({
      type: "http",
      url: "https://example.test/mcp",
      executionScope: "shared",
    })).toBe(false);
  });

  it("classifies remote servers as direct", () => {
    expect(classifyMcpServerExecution({
      type: "http",
      url: "https://example.test/mcp",
    })).toMatchObject({
      requestedScope: "auto",
      desiredMode: "direct",
      effectiveMode: "direct",
      shareCandidate: false,
    });
  });

  it("keeps automatic local candidates isolated until broker validation passes", () => {
    const config = { command: "agency", args: ["mcp", "ado"] };

    expect(classifyMcpServerExecution(config)).toMatchObject({
      requestedScope: "auto",
      desiredMode: "shared",
      effectiveMode: "session",
      shareCandidate: true,
    });
    expect(classifyMcpServerExecution(config, {
      sharedBrokerAvailable: true,
      sharingVerified: true,
    })).toMatchObject({
      desiredMode: "shared",
      effectiveMode: "shared",
      shareCandidate: true,
    });
  });

  it("keeps automatic custom environment and working-directory configs session-isolated", () => {
    expect(classifyMcpServerExecution({
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "value" },
    })).toMatchObject({
      desiredMode: "session",
      effectiveMode: "session",
      shareCandidate: false,
    });
    expect(classifyMcpServerExecution({
      command: "node",
      args: ["server.js"],
      workingDirectory: "D:\\workspace",
    }).reason).toContain("working directory");
  });

  it("allows explicit shared intent to proceed only after broker validation", () => {
    const config = {
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "value" },
      executionScope: "shared" as const,
    };

    expect(classifyMcpServerExecution(config)).toMatchObject({
      desiredMode: "shared",
      effectiveMode: "session",
      shareCandidate: true,
    });
    expect(classifyMcpServerExecution(config, {
      sharedBrokerAvailable: true,
      sharingVerified: true,
    })).toMatchObject({
      desiredMode: "shared",
      effectiveMode: "shared",
      shareCandidate: true,
    });
  });

  it("honors explicit session isolation", () => {
    expect(classifyMcpServerExecution({
      command: "node",
      args: ["server.js"],
      executionScope: "session",
    })).toMatchObject({
      requestedScope: "session",
      desiredMode: "session",
      effectiveMode: "session",
      shareCandidate: false,
    });
  });
});
