import { CopilotClient, CopilotSession, defineTool, type SessionConfig } from "@github/copilot-sdk";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../shared/is-record.js";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import type { AgentSession } from "../agent-backend/types.js";
import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { makeTestDir, registerTestAppCleanup } from "./helpers.js";
import { stopCopilotRuntime } from "./copilot-native-runtime.js";

function sdkSession(session: AgentSession): CopilotSession {
  const raw: unknown = Reflect.get(session, "session");
  if (!(raw instanceof CopilotSession)) throw new Error("Expected the installed SDK session");
  return raw;
}

const mcpTools = Array.from({ length: 35 }, (_, index) => ({
  name: `read_${index}`,
  description: `Read synthetic fixture ${index}.`,
  inputSchema: { type: "object", properties: {} },
}));

async function fixture(signal: AbortSignal) {
  const home = makeTestDir("copilot-tool-loading");
  const cwd = join(home, "workspace");
  const requests: Record<string, unknown>[] = [];
  const fixtureErrors: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const input: unknown = JSON.parse(body);
      if (!isRecord(input)) { response.writeHead(400).end(); return; }
      if (request.url === "/mcp") {
        if (!("id" in input)) { response.writeHead(202).end(); return; }
        const result = input.method === "initialize"
          ? {
            protocolVersion: isRecord(input.params) ? input.params.protocolVersion : "2025-03-26",
            capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
          }
          : input.method === "tools/list" ? { tools: mcpTools }
            : input.method === "tools/call" ? { content: [{ type: "text", text: "fixture result" }] }
              : {};
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        fixtureErrors.push(`Unexpected request: ${request.method} ${request.url}`);
        response.writeHead(404).end();
        return;
      }
      requests.push(input);
      const message = { role: "assistant", content: "Eager tools fixture finished." };
      if (input.stream === true) {
        response.setHeader("Content-Type", "text/event-stream");
        response.end(`data: ${JSON.stringify({
          id: "fixture", object: "chat.completion.chunk", created: 0, model: input.model,
          choices: [{ index: 0, delta: message, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`);
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          id: "fixture", object: "chat.completion", created: 0, model: input.model,
          choices: [{ index: 0, message, finish_reason: "stop" }],
        }));
      }
    });
  });
  const client = new CopilotClient({
    ...buildCopilotClientOptions({ ...process.env, COPILOT_HOME: home }),
    useLoggedInUser: false, mode: "empty", baseDirectory: join(home, "session-state"), logLevel: "error",
  });
  let closing = false;
  const start = client.start.bind(client);
  client.start = async () => {
    if (closing) throw new Error("Eager tools fixture is closed");
    await start();
  };
  const backend = new CopilotBackend(client, { localStdioOwnership: true });
  const setup = (async () => {
    await mkdir(cwd);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    await backend.start();
  })();
  const cleanup = registerTestAppCleanup(async () => {
    closing = true;
    try { await setup; }
    finally {
      try { await stopCopilotRuntime(backend); }
      finally {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  });
  await setup;
  signal.throwIfAborted();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback address");
  const config = {
    model: "gpt-5-mini", workingDirectory: cwd,
    memory: { enabled: false }, enableConfigDiscovery: false, skillDirectories: [], instructionDirectories: [],
    availableTools: ["task", "custom:*", "mcp:*"],
    mcpServers: { fixture: { type: "http", url: `http://127.0.0.1:${address.port}/mcp`, tools: ["*"] } },
    tools: [
      defineTool("external_eager", {
        description: "An external tool that is always loaded.", defer: "never",
        parameters: { type: "object", properties: {} }, handler: async () => "fixture result",
      }),
      defineTool("external_fixture", {
        description: "An external tool that loads on demand.", defer: "auto",
        parameters: { type: "object", properties: {} }, handler: async () => "fixture result",
      }),
    ],
    customAgents: [{ name: "fixture-agent", description: "Local test agent.", prompt: "Return the fixture response." }],
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "completions" },
  } satisfies SessionConfig;
  return { client, backend, config, requests, fixtureErrors, cleanup };
}

function requestToolNames(request: Record<string, unknown> | undefined): unknown[] {
  expect(request).toBeDefined();
  return Array.isArray(request?.tools) ? request.tools.map((tool: unknown) =>
    isRecord(tool) && isRecord(tool.function) ? tool.function.name : undefined,
  ) : [];
}

function assertToolPolicy(request: Record<string, unknown> | undefined) {
  const names = requestToolNames(request);
  expect(names).toContain("external_eager");
  for (const tool of mcpTools) expect(names).toContain(`fixture-${tool.name}`);
  expect(names).toContain("tool_search_tool");
  expect(names).not.toContain("external_fixture");
}

describe("native tool loading policy", () => {
  it("keeps MCP and always-loaded definitions and defers only on-demand tools on create, model/agent switch, subagent and cold resume", async ({ signal }) => {
    const { backend, config, requests, fixtureErrors, cleanup } = await fixture(signal);
    try {
      const session = await backend.createSession(config);
      await session.initializeTools();
      const metadata = await session.getCurrentToolMetadata();
      expect(metadata?.tools?.map((tool) => tool.name)).toContain("external_fixture");
      await session.sendAndWait({ prompt: "Return the fixture response." }, null);
      assertToolPolicy(requests.at(-1));

      await session.setModel("gpt-4.1");
      await session.sendAndWait({ prompt: "Return the fixture response after switching model." }, null);
      expect(requests.at(-1)?.model).toBe("gpt-4.1");
      assertToolPolicy(requests.at(-1));

      const raw = sdkSession(session);
      await raw.rpc.agent.select({ name: "fixture-agent" });
      await session.sendAndWait({ prompt: "Return the fixture response as the selected agent." }, null);
      assertToolPolicy(requests.at(-1));
      await raw.rpc.agent.deselect();

      const beforeChild = requests.length;
      const child = await raw.rpc.tools.execute({
        name: "task",
        arguments: {
          description: "Check child tool definitions", prompt: "Return the fixture response.",
          agent_type: "fixture-agent", name: "tool-loading-child", mode: "sync",
        },
      });
      expect(child, typeof child === "string" ? child : child.textResultForLlm).toMatchObject({ resultType: "success" });
      expect(requests.length).toBeGreaterThan(beforeChild);
      assertToolPolicy(requests.at(-1));
      await session.release();

      const resumed = await backend.resumeSession(session.sessionId, config);
      await resumed.initializeTools();
      await resumed.sendAndWait({ prompt: "Return the fixture response after cold resume." }, null);
      assertToolPolicy(requests.at(-1));
      await resumed.release();

      expect(fixtureErrors).toEqual([]);
    } finally { await cleanup(); }
  });
});
