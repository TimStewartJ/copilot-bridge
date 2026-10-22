import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../shared/is-record.js";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import type { AgentSession } from "../agent-backend/types.js";
import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { getProcessHost } from "../process-host.js";
import { buildSessionConfig } from "../session-config-builder.js";
import { createTaskAgentDefinitionStore } from "../task-agent-definition-store.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestDir, registerTestAppCleanup, setupTestDb } from "./helpers.js";
import { stopCopilotRuntime } from "./copilot-native-runtime.js";

function sdkSession(session: AgentSession): CopilotSession {
  const raw: unknown = Reflect.get(session, "session");
  if (!(raw instanceof CopilotSession)) throw new Error("Expected the installed SDK session");
  return raw;
}

async function writeFixture(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(signal: AbortSignal) {
  const home = makeTestDir("copilot-config-discovery");
  const project = join(home, "project");
  const cwd = join(project, "packages", "core");
  const otherProject = join(home, "other-project");
  const hookMarker = join(project, "hook-ran.txt");
  const mcpRequests: string[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const db = setupTestDb();
  const task = createTaskStore(db, createTestBus()).createTask("Discovery fixture");
  const taskAgentDefinitionStore = createTaskAgentDefinitionStore({ dataDir: join(home, "data") });
  taskAgentDefinitionStore.createTaskAgentDefinition({
    taskId: task.id,
    name: "bridge-reviewer",
    description: "Bridge-defined reviewer.",
    prompt: "The Bridge-defined reviewer takes precedence.",
    tools: ["view"],
  });
  const server = createServer((request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const input: unknown = JSON.parse(body);
      if (!isRecord(input)) { response.writeHead(400).end(); return; }
      if (request.url === "/v1/chat/completions") {
        modelRequests.push(input);
        const message = { role: "assistant", content: "Discovery fixture finished." };
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
        return;
      }
      mcpRequests.push(request.url ?? "");
      if (!("id" in input)) { response.writeHead(202).end(); return; }
      const result = input.method === "initialize"
        ? {
          protocolVersion: isRecord(input.params) ? input.params.protocolVersion : "2025-03-26",
          capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
        }
        : input.method === "tools/list"
          ? { tools: ["allowed", "not_allowed"].map((name) => ({
            name, description: name, inputSchema: { type: "object", properties: {} },
          })) }
          : {};
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    });
  });
  const env = {
    ...process.env, COPILOT_HOME: home, BRIDGE_WORKSPACE_DIR: join(home, "runtime-workspace"),
    BRIDGE_COPILOT_GITHUB_TOKEN: "",
  };
  const client = new CopilotClient({
    ...buildCopilotClientOptions(env),
    useLoggedInUser: false, baseDirectory: join(home, "session-state"), logLevel: "error",
  });
  const backend = new CopilotBackend(client, { localStdioOwnership: true });
  const setup = (async () => {
    await mkdir(cwd, { recursive: true });
    await mkdir(otherProject);
    for (const root of [project, otherProject]) {
      await getProcessHost().execFile("git", ["init", "--quiet", root]);
    }
    for (const [directory, name] of [
      [join(project, ".github", "skills"), "repo-github"],
      [join(project, ".claude", "skills"), "repo-claude"],
      [join(project, ".agents", "skills"), "repo-agents"],
      [join(home, "skills"), "personal-fixture"],
      [join(otherProject, ".github", "skills"), "other-repo"],
    ] as const) {
      await writeFixture(join(directory, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Isolated discovery fixture.\n---\n${name} instructions.\n`);
    }
    for (const name of ["repo-reviewer", "bridge-reviewer"]) {
      await writeFixture(join(project, ".github", "agents", `${name}.agent.md`),
        `---\nname: ${name}\ndescription: Repository reviewer.\ntools: ["view"]\n---\nRepository-defined reviewer.\n`);
    }
    await writeFixture(join(project, "hook.mjs"),
      'import { writeFile } from "node:fs/promises"; await writeFile("hook-ran.txt", "hook ran");\n');
    await writeFixture(join(project, ".github", "hooks", "fixture.json"), JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ type: "command", bash: "node hook.mjs", powershell: "node hook.mjs" }] },
    }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFixture(join(home, "mcp-config.json"), JSON.stringify({
      mcpServers: {
        fixture: { type: "http", url: `${origin}/ambient-collision`, tools: ["*"] },
        unselected: { type: "http", url: `${origin}/ambient-only`, tools: ["*"] },
      },
    }));
    await backend.start();
    return origin;
  })();
  const cleanup = registerTestAppCleanup(async () => {
    try { await setup; }
    finally {
      try { await stopCopilotRuntime(backend); }
      finally {
        db.close();
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  });
  const origin = await setup;
  signal.throwIfAborted();
  const configFor = (workingDirectory = cwd, forResume = false) => {
    const config = buildSessionConfig({
      deps: {
        config: { sessionMcpServers: { fixture: { type: "http", url: `${origin}/explicit`, tools: ["allowed"] } } },
        clientEnv: env, taskAgentDefinitionStore,
      },
      options: { task, forResume },
      callbacks: { resolveEffectiveSessionCwd: () => workingDirectory, getCopilotHome: () => home },
    });
    delete config.githubMcpToolConfig;
    return {
      ...config,
      ...(!forResume ? { model: "gpt-5-mini" } : {}),
      provider: { type: "openai", baseUrl: `${origin}/v1`, wireApi: "completions" },
    };
  };
  return { backend, configFor, project, otherProject, hookMarker, mcpRequests, modelRequests, cleanup };
}

async function assertProjectCatalog(session: AgentSession, modelRequests: readonly Record<string, unknown>[]) {
  const raw = sdkSession(session);
  await session.initializeTools();
  const skills = (await raw.rpc.skills.list()).skills;
  for (const name of ["repo-github", "repo-claude", "repo-agents", "personal-fixture", "browser"]) {
    expect(skills).toContainEqual(expect.objectContaining({ name, enabled: true }));
  }
  const agents = (await raw.rpc.agent.list()).agents;
  expect(agents).toContainEqual(expect.objectContaining({ name: "repo-reviewer" }));
  expect(agents).toContainEqual(expect.objectContaining({
    name: "bridge-reviewer", description: "Bridge-defined reviewer.", tools: ["view"],
  }));
  expect(agents.filter((agent) => agent.name === "bridge-reviewer")).toHaveLength(1);
  expect((await raw.rpc.mcp.listConfigured()).servers.map((server) => server.name)).toEqual(["fixture"]);
  const tools = (await session.getCurrentToolMetadata())?.tools?.map((tool) => tool.name);
  expect(tools).toContain("fixture-allowed");
  expect(tools).not.toContain("fixture-not_allowed");
  expect(await raw.rpc.tools.execute({ name: "skill", arguments: { skill: "repo-github" } }))
    .toMatchObject({ resultType: "success" });
  expect((await raw.rpc.skills.getInvoked()).skills).toContainEqual(expect.objectContaining({
    name: "repo-github", content: expect.stringContaining("repo-github instructions."),
  }));
  await raw.rpc.agent.select({ name: "bridge-reviewer" });
  await session.sendAndWait({ prompt: "Persist this local discovery fixture." }, null);
  expect(JSON.stringify(modelRequests.at(-1)?.messages)).toContain("The Bridge-defined reviewer takes precedence.");
  expect(JSON.stringify(modelRequests.at(-1)?.messages)).not.toContain("Repository-defined reviewer.");
  await raw.rpc.agent.deselect();
}

describe("native workspace configuration discovery", () => {
  it("loads usable project skills and agents on create/resume while preserving explicit configuration", async ({ signal }) => {
    const { backend, configFor, otherProject, hookMarker, mcpRequests, modelRequests, cleanup } = await fixture(signal);
    try {
      const session = await backend.createSession(configFor());
      await assertProjectCatalog(session, modelRequests);
      await session.release();

      const resumed = await backend.resumeSession(session.sessionId, configFor(undefined, true));
      await assertProjectCatalog(resumed, modelRequests);
      await resumed.release();

      const switched = await backend.resumeSession(session.sessionId, configFor(otherProject, true));
      const skills = (await sdkSession(switched).rpc.skills.list()).skills.map((skill) => skill.name);
      expect(skills).toContain("other-repo");
      expect(skills).toContain("personal-fixture");
      expect(skills).not.toContain("repo-github");
      expect((await sdkSession(switched).rpc.agent.list()).agents.map((agent) => agent.name)).not.toContain("repo-reviewer");
      await switched.release();

      const legacy = await backend.createSession({ ...configFor(), enableConfigDiscovery: false });
      expect((await sdkSession(legacy).rpc.skills.list()).skills.map((skill) => skill.name)).not.toContain("repo-github");
      await legacy.sendAndWait({ prompt: "Persist this local legacy fixture." }, null);
      await legacy.release();
      const upgraded = await backend.resumeSession(legacy.sessionId, configFor(undefined, true));
      await assertProjectCatalog(upgraded, modelRequests);
      await upgraded.release();
      await expect(readFile(hookMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(mcpRequests.length).toBeGreaterThan(0);
      expect(mcpRequests.every((path) => path === "/explicit")).toBe(true);
    } finally { await cleanup(); }
  });

  it("preserves empty MCP selections and repository hook opt-outs", async ({ signal }) => {
    const { backend, configFor, project, hookMarker, mcpRequests, cleanup } = await fixture(signal);
    try {
      const config = configFor(project);
      config.mcpServers = {};
      delete config.customAgents;
      delete config.customAgentsLocalOnly;
      const disabled = await backend.createSession(config);
      expect((await sdkSession(disabled).rpc.mcp.listConfigured()).servers).toEqual([]);
      expect((await sdkSession(disabled).rpc.agent.list()).agents).toContainEqual(expect.objectContaining({
        name: "bridge-reviewer", description: "Repository reviewer.",
      }));
      await disabled.sendAndWait({ prompt: "Finish this local hook opt-out fixture." }, null);
      await disabled.release();
      await expect(readFile(hookMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const control = await backend.createSession({ ...config, enableFileHooks: true });
      await control.sendAndWait({ prompt: "Finish this local positive-control fixture." }, null);
      await control.release();
      expect(await readFile(hookMarker, "utf8")).toBe("hook ran");
      expect(mcpRequests).toEqual([]);
    } finally { await cleanup(); }
  });
});
