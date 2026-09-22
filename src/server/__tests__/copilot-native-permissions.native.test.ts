import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import type { AgentSession } from "../agent-backend/types.js";
import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { makeTestDir, registerTestAppCleanup } from "./helpers.js";

function sdkSession(session: AgentSession): CopilotSession {
  const raw: unknown = Reflect.get(session, "session");
  if (!(raw instanceof CopilotSession)) throw new Error("Expected an installed SDK session behind the facade");
  return raw;
}

async function fixture(signal: AbortSignal) {
  const home = makeTestDir("copilot-native-permissions");
  const cwd = join(home, "workspace");
  const file = join(home, "outside-workspace.txt");
  const modelRequests: string[] = [];
  const provider = createServer((request, response) => {
    modelRequests.push(`${request.method} ${request.url}`);
    let body = "";
    request.setEncoding("utf-8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const message = { role: "assistant", content: "Native fixture finished." };
      response.setHeader("Content-Type", "text/event-stream");
      if (JSON.parse(body).stream === true) {
        const chunk = {
          id: "native-fixture", object: "chat.completion.chunk", created: 0, model: "gpt-5-mini",
          choices: [{ index: 0, delta: message, finish_reason: "stop" }],
        };
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          id: "native-fixture", object: "chat.completion", created: 0, model: "gpt-5-mini",
          choices: [{ index: 0, message, finish_reason: "stop" }],
        }));
      }
    });
  });
  const client = new CopilotClient({
    ...buildCopilotClientOptions({ ...process.env, COPILOT_HOME: home }),
    useLoggedInUser: false,
    mode: "empty",
    baseDirectory: join(home, "session-state"),
    logLevel: "error",
  });
  let closing = false;
  const startClient = client.start.bind(client);
  client.start = async () => {
    if (closing) throw new Error("Native permission fixture is closed");
    await startClient();
  };
  // Process-tree fencing is covered by copilot-backend-recovery.native.test.ts.
  // Permissions need the real SDK adapter, not its recovery/host-snapshot machinery.
  const backend = new CopilotBackend(client);
  const setup = (async () => {
    await mkdir(cwd);
    await writeFile(file, "before\n");
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", () => { provider.off("error", reject); resolve(); });
    });
    await backend.start();
  })();
  const cleanup = registerTestAppCleanup(async () => {
    closing = true;
    try {
      await setup;
    } finally {
      try {
        await backend.stop();
      } finally {
        provider.closeAllConnections();
        if (provider.listening) {
          await new Promise<void>((resolve, reject) => {
            provider.close((error) => error ? reject(error) : resolve());
          });
        }
      }
    }
  });
  await setup;
  signal.throwIfAborted();
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback provider address");
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const config = {
    model: "gpt-5-mini",
    workingDirectory: cwd,
    memory: { enabled: false },
    enableConfigDiscovery: false,
    skillDirectories: [],
    instructionDirectories: [],
    mcpServers: {},
    availableTools: ["view", "edit", shell],
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "completions" },
  };
  return { backend, file, shell, config, modelRequests, cleanup };
}

describe("native Copilot automatic tool approvals", () => {
  it("honors create/resume approvals and managed restrictions in one isolated runtime", async ({ signal }) => {
    const { backend, file, shell, config, modelRequests, cleanup } = await fixture(signal);
    let permissionRequests = 0;
    try {
      const session = await backend.createSession(config);
      const raw = sdkSession(session);
      raw.on("permission.requested", () => { permissionRequests++; });
      await session.initializeTools();
      expect(await raw.rpc.permissions.getMode()).toEqual({ mode: "allow-all" });
      expect(await raw.rpc.tools.execute({ name: "view", arguments: { path: file } }))
        .toMatchObject({ resultType: "success", textResultForLlm: "before\n" });
      expect(await raw.rpc.tools.execute({ name: "edit", arguments: { path: file, old_str: "before", new_str: "after" } }))
        .toMatchObject({ resultType: "success" });
      const command = process.platform === "win32" ? "Write-Output 'native fixture'" : "printf 'native fixture\\n'";
      expect(await raw.rpc.tools.execute({ name: shell, arguments: { command, description: "Native permission fixture", mode: "sync" } }))
        .toMatchObject({ resultType: "success", textResultForLlm: expect.stringContaining("native fixture") });
      expect(await readFile(file, "utf-8")).toBe("after\n");
      // Empty sessions are discarded on detach. One loopback response persists
      // the conversation needed to test a real cold resume, without cloud inference.
      await expect(session.sendAndWait({ prompt: "Finish this local diagnostic fixture." }, null))
        .resolves.toMatchObject({ data: { content: "Native fixture finished." } });
      await session.release();

      const resumed = await backend.resumeSession(session.sessionId, config);
      const resumedRaw = sdkSession(resumed);
      resumedRaw.on("permission.requested", () => { permissionRequests++; });
      await resumedRaw.rpc.permissions.setMode({ mode: "manual" });
      await resumed.initializeTools();
      expect(await resumedRaw.rpc.permissions.getMode()).toEqual({ mode: "allow-all" });
      expect(await resumedRaw.rpc.tools.execute({ name: "view", arguments: { path: file } }))
        .toMatchObject({ resultType: "success", textResultForLlm: "after\n" });
      expect(permissionRequests).toBe(0);
      await resumed.release();

      const restricted = await backend.createSession({
        ...config,
        managedSettings: { permissions: { deny: ["write"] } },
      });
      await restricted.initializeTools();
      expect(await sdkSession(restricted).rpc.tools.execute({
        name: "edit", arguments: { path: file, old_str: "after", new_str: "must-not-change" },
      })).toMatchObject({ resultType: "denied" });
      expect(await readFile(file, "utf-8")).toBe("after\n");
      await restricted.release();

      const disabled = await backend.createSession({
        ...config,
        managedSettings: { permissions: { disableBypassPermissionsMode: "disable" } },
      });
      let deliveredPrompts = 0;
      const disabledRaw = sdkSession(disabled);
      disabledRaw.on("user.message", () => { deliveredPrompts++; });
      await expect(disabled.initializeTools()).rejects.toThrow("did not enable native tool approvals");
      await expect(disabled.send({ prompt: "must not reach the model" })).rejects.toThrow("did not enable native tool approvals");
      expect(await disabledRaw.rpc.permissions.getMode()).toEqual({ mode: "manual" });
      expect(deliveredPrompts).toBe(0);
      await disabled.release();
      expect(modelRequests).toEqual(["POST /v1/chat/completions"]);
    } finally {
      await cleanup();
    }
    expect(backend.getConnectionStatus().state).toBe("disconnected");
    await expect(backend.createSession(config)).rejects.toThrow("Native permission fixture is closed");
  });
});
