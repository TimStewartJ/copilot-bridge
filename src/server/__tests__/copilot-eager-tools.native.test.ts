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
  const home = makeTestDir("copilot-eager-tools");
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
  const backend = new CopilotBackend(client);
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
      try { await backend.stop(); }
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
    tools: [defineTool("external_fixture", {
      description: "An external tool that normally allows deferral.", defer: "auto",
      parameters: { type: "object", properties: {} }, handler: async () => "fixture result",
    })],
    customAgents: [{ name: "fixture-agent", description: "Local test agent.", prompt: "Return the fixture response." }],
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "completions" },
  } satisfies SessionConfig;
  return { client, backend, config, requests, fixtureErrors, cleanup };
}

function assertEagerRequest(request: Record<string, unknown> | undefined) {
  expect(request).toBeDefined();
  const names = Array.isArray(request?.tools) ? request.tools.map((tool: unknown) =>
    isRecord(tool) && isRecord(tool.function) ? tool.function.name : undefined,
  ) : [];
  expect(names).toContain("external_fixture");
  for (const tool of mcpTools) expect(names).toContain(`fixture-${tool.name}`);
  expect(names.length).toBeGreaterThan(30);
  expect(names).not.toContain("tool_search_tool");
}

describe("native eager tool definitions", () => {
  it("sends all MCP/external definitions on create, model/agent switch, subagent and cold resume", async ({ signal }) => {
    const { client, backend, config, requests, fixtureErrors, cleanup } = await fixture(signal);
    try {
      const session = await backend.createSession(config);
      await session.initializeTools();
      const metadata = await session.getCurrentToolMetadata();
      expect(metadata?.tools?.some((tool) => tool.deferLoading === true)).toBe(false);
      await session.sendAndWait({ prompt: "Return the fixture response." }, null);
      assertEagerRequest(requests.at(-1));

      await session.setModel("gpt-4.1");
      await session.sendAndWait({ prompt: "Return the fixture response after switching model." }, null);
      expect(requests.at(-1)?.model).toBe("gpt-4.1");
      assertEagerRequest(requests.at(-1));

      const raw = sdkSession(session);
      await raw.rpc.agent.select({ name: "fixture-agent" });
      await session.sendAndWait({ prompt: "Return the fixture response as the selected agent." }, null);
      assertEagerRequest(requests.at(-1));
      await raw.rpc.agent.deselect();

      const beforeChild = requests.length;
      const child = await raw.rpc.tools.execute({
        name: "task",
        arguments: {
          description: "Check child tool definitions", prompt: "Return the fixture response.",
          agent_type: "fixture-agent", name: "eager-fixture-child", mode: "sync",
        },
      });
      expect(child, typeof child === "string" ? child : child.textResultForLlm).toMatchObject({ resultType: "success" });
      expect(requests.length).toBeGreaterThan(beforeChild);
      assertEagerRequest(requests.at(-1));
      await session.release();

      const resumed = await backend.resumeSession(session.sessionId, config);
      await resumed.initializeTools();
      await resumed.sendAndWait({ prompt: "Return the fixture response after cold resume." }, null);
      assertEagerRequest(requests.at(-1));
      await resumed.release();

      const legacy = await client.createSession({ ...config, toolSearch: { enabled: true, deferThreshold: 1 } });
      await legacy.rpc.tools.initializeAndValidate();
      await legacy.sendAndWait({ prompt: "Persist this session created with tool search enabled." });
      // This loopback completions provider does not activate deferral, even when
      // requested. This test guards payload/lifecycle fidelity; adapter tests
      // enforce the disabled policy, and CAPI deferral needs a real preview smoke.
      assertEagerRequest(requests.at(-1));
      await legacy.disconnect();
      const upgraded = await backend.resumeSession(legacy.sessionId, config);
      await upgraded.initializeTools();
      await upgraded.sendAndWait({ prompt: "Return the fixture response with eager tools after resume." }, null);
      assertEagerRequest(requests.at(-1));
      await upgraded.release();
      expect(fixtureErrors).toEqual([]);
    } finally { await cleanup(); }
  });
});
