import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import type { AgentSession } from "../agent-backend/types.js";
import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { SessionAgentRegistry } from "../session-agent-registry.js";
import { makeTestDir, registerTestAppCleanup } from "./helpers.js";

/**
 * The Bridge's handling of background commands rests on three things the runtime does, none of
 * which the SDK documents: it lists a running command as an attached shell task with a start
 * time, it stops the command when the session's handle is released, and a resumed session knows
 * nothing about it. This pins them against the installed runtime with no model in the loop.
 */

function sdkSession(session: AgentSession): CopilotSession {
  const raw: unknown = Reflect.get(session, "session");
  if (!(raw instanceof CopilotSession)) throw new Error("Expected an installed SDK session behind the facade");
  return raw;
}

async function fixture(signal: AbortSignal) {
  const home = makeTestDir("copilot-background-commands");
  const cwd = join(home, "workspace");
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf-8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const message = { role: "assistant", content: "Native fixture finished." };
      if (JSON.parse(body).stream === true) {
        response.setHeader("Content-Type", "text/event-stream");
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
  const backend = new CopilotBackend(client);
  const setup = (async () => {
    await mkdir(cwd);
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", () => { provider.off("error", reject); resolve(); });
    });
    await backend.start();
  })();
  const cleanup = registerTestAppCleanup(async () => {
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
    availableTools: ["view", shell],
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "completions" },
  };
  return { backend, shell, config, cleanup };
}

describe("native background commands", () => {
  it("lists a running command as an attached shell task and stops it when the session is released", async ({ signal }) => {
    const { backend, shell, config, cleanup } = await fixture(signal);
    // Long enough that it cannot finish on its own while the test runs, short enough not to linger if it survives.
    const runSeconds = 90;
    const command = process.platform === "win32" ? `Start-Sleep -Seconds ${runSeconds}` : `sleep ${runSeconds}`;
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const session = await backend.createSession(config);
      await session.initializeTools();
      // An empty session is discarded on release; one turn makes it resumable.
      await session.sendAndWait({ prompt: "Finish this local diagnostic fixture." }, null);
      const startedAfter = Date.now() - 5_000;
      await expect(sdkSession(session).rpc.tools.execute({
        name: shell,
        arguments: { command, description: "Native background command fixture", mode: "async" },
      })).resolves.toMatchObject({ resultType: "success" });

      const registry = new SessionAgentRegistry({
        globalBus: { emit: () => {}, subscribe: () => () => {} } as any,
        getLiveSession: () => session,
      });
      try {
        await registry.refresh(session.sessionId, "native fixture");
        const [running] = registry.getRunningCommands(session.sessionId);
        expect(running).toMatchObject({ description: "Native background command fixture" });
        expect(running?.shellId).toBeTruthy();
        expect(running?.command).toContain(String(runSeconds));
        expect(Date.parse(running!.startedAt)).toBeGreaterThan(startedAfter);
        expect(registry.hasProtectedCommand(session.sessionId)).toBe(true);
        // The runtime does not count a running command as work, which is why the Bridge has to.
        await expect(session.getActivity()).resolves.toMatchObject({ processing: false });
      } finally {
        registry.dispose();
      }
      const listed = await sdkSession(session).rpc.tasks.list() as { tasks: Array<{ type?: string; pid?: number }> };
      const pid = listed.tasks.find((task) => task.type === "shell")?.pid;
      if (typeof pid === "number") expect(isAlive(pid)).toBe(true);

      await expect(session.release()).resolves.toMatchObject({ status: "released" });
      // Releasing the handle is what stops the command: its process goes away without finishing.
      if (typeof pid === "number") await vi.waitFor(() => expect(isAlive(pid)).toBe(false));

      const resumed = await backend.resumeSession(session.sessionId, config);
      await resumed.initializeTools();
      const tasks = (await resumed.listTasks())?.tasks ?? [];
      expect(tasks.filter((task) => task.kind === "shell" && task.status === "running")).toEqual([]);
      await resumed.release();
    } finally {
      await cleanup();
    }
  });
});
