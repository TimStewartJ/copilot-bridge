import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import type { AppContext } from "../../app-context.js";
import { makeTestDir } from "../../__tests__/helpers.js";
import {
  BRIDGE_MCP_ENDPOINT_ENV,
  BridgeToolsMcpServer,
  createBridgeToolsMcpEndpoint,
} from "../index.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const shimSourcePath = join(repoRoot, "src", "server", "agent-tools-mcp", "shim.ts");

function stringEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

describe("BridgeToolsMcpServer transport", () => {
  it("builds short POSIX socket paths and Windows named pipe endpoints", () => {
    expect(createBridgeToolsMcpEndpoint({
      pid: 123,
      platform: "linux",
      tmpDir: join("tmp", "bridge"),
    })).toBe(join("tmp", "bridge", "copilot-bridge-mcp-123.sock"));

    expect(createBridgeToolsMcpEndpoint({
      dataDir: join("very", "long", "data"),
      pid: 123,
      platform: "win32",
    })).toMatch(/^\\\\\.\\pipe\\copilot-bridge-mcp-123-[a-f0-9]{8}$/);

    expect(createBridgeToolsMcpEndpoint({
      dataDir: join("very", "long", "data"),
      pid: 123,
      platform: "linux",
      sessionId: "session-abc",
      tmpDir: join("tmp", "bridge"),
    })).toMatch(/^tmp[/\\]bridge[/\\]copilot-bridge-mcp-123-[a-f0-9]{8}-[a-f0-9]{10}\.sock$/);
  });
  it("serves a tool through the stdio shim over a local socket", async () => {
    const tempDir = makeTestDir("mcp-transport");
    const endpoint = createBridgeToolsMcpEndpoint({
      dataDir: tempDir,
      platform: "linux",
      pid: process.pid,
      tmpDir: tempDir,
    });
    const server = new BridgeToolsMcpServer({} as AppContext);
    server.registerTool({
      name: "bridge_transport_echo",
      description: "Echo a message through the Bridge MCP transport",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      handler: async (args) => `echo:${String(args.message)}`,
    });
    server.registerTool({
      name: "bridge_transport_failure",
      description: "Return a legacy Bridge tool failure",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({
        textResultForLlm: "legacy failure text",
        resultType: "failure",
        error: "legacy failure text",
      }),
    });
    await server.listen(endpoint);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", shimSourcePath],
      env: stringEnv({ [BRIDGE_MCP_ENDPOINT_ENV]: endpoint }),
      cwd: repoRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "bridge-mcp-test-client", version: "0.1.0" });

    try {
      await client.connect(transport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "bridge_transport_echo",
        "bridge_transport_failure",
      ]);

      const result = await client.callTool({
        name: "bridge_transport_echo",
        arguments: { message: "hello" },
      });
      expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);

      const failure = await client.callTool({
        name: "bridge_transport_failure",
        arguments: {},
      });
      expect(failure).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "legacy failure text" }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("injects the trusted Bridge session id on a session-scoped endpoint", async () => {
    const tempDir = makeTestDir("mcp-session-transport");
    const sessionId = "bridge-session-1";
    const globalEndpoint = createBridgeToolsMcpEndpoint({
      dataDir: tempDir,
      platform: "linux",
      pid: process.pid,
      tmpDir: tempDir,
    });
    const sessionEndpoint = createBridgeToolsMcpEndpoint({
      dataDir: tempDir,
      platform: "linux",
      pid: process.pid,
      sessionId,
      tmpDir: tempDir,
    });
    const server = new BridgeToolsMcpServer({} as AppContext);
    server.registerTool({
      name: "global_echo",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "global",
    });
    server.registerTool({
      name: "session_identity",
      scope: "session",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, extra) => ({ sessionId: extra.sessionId }),
    });
    await server.listen(globalEndpoint);
    await server.listenForSession(sessionId, sessionEndpoint);

    const globalClient = new Client({ name: "bridge-global-client", version: "0.1.0" });
    const sessionClient = new Client({ name: "bridge-session-client", version: "0.1.0" });

    try {
      await globalClient.connect(new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", shimSourcePath],
        env: stringEnv({ [BRIDGE_MCP_ENDPOINT_ENV]: globalEndpoint }),
        cwd: repoRoot,
        stderr: "pipe",
      }));
      await sessionClient.connect(new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", shimSourcePath],
        env: stringEnv({ [BRIDGE_MCP_ENDPOINT_ENV]: sessionEndpoint }),
        cwd: repoRoot,
        stderr: "pipe",
      }));

      expect((await globalClient.listTools()).tools.map((tool) => tool.name)).toEqual(["global_echo"]);
      expect((await sessionClient.listTools()).tools.map((tool) => tool.name)).toEqual(["session_identity"]);

      const result = await sessionClient.callTool({ name: "session_identity", arguments: {} }) as any;
      expect(result.content?.[0]).toEqual({
        type: "text",
        text: JSON.stringify({ sessionId }, null, 2),
      });
      await expect(globalClient.callTool({ name: "session_identity", arguments: {} })).rejects.toThrow(
        /not available/,
      );
    } finally {
      await globalClient.close();
      await sessionClient.close();
      await server.close();
    }
  });
});
