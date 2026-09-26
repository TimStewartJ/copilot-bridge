import { CopilotClient } from "@github/copilot-sdk";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../shared/is-record.js";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import type { AgentSessionConfig } from "../agent-backend/types.js";
import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { buildSessionConfig } from "../session-config-builder.js";
import { createSettingsStore } from "../settings-store.js";
import { DEFAULT_IDENTITY } from "../session-instructions.js";
import { makeTestDir, registerTestAppCleanup, setupTestDb } from "./helpers.js";

// Guards the system prompt the pinned Copilot CLI actually assembles from the Bridge's
// section overrides. The CLI renders sections itself, so builder unit tests cannot see
// what reaches the model: a renamed section or a group override silently changes it.

function systemPromptOf(request: Record<string, unknown> | undefined): string {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const system = messages.find((message: unknown) => isRecord(message) && message.role === "system");
  if (!isRecord(system)) return "";
  if (typeof system.content === "string") return system.content;
  return Array.isArray(system.content)
    ? system.content.map((part: unknown) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("")
    : "";
}

async function fixture(signal: AbortSignal) {
  const home = makeTestDir("copilot-system-prompt");
  const cwd = join(home, "workspace");
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const input: unknown = JSON.parse(body);
      if (!isRecord(input)) { response.writeHead(400).end(); return; }
      requests.push(input);
      const message = { role: "assistant", content: "System prompt fixture finished." };
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
  // Normal client mode, as in production: "empty" mode changes the coauthor and
  // custom-instruction defaults this test must observe.
  // Vitest runs from the repository root, like the production server runs from the Bridge
  // checkout. The Bridge workspace option must keep that repository's instructions out of
  // sessions whose own folder has none.
  const workspace = join(home, "bridge-workspace");
  const client = new CopilotClient({
    ...buildCopilotClientOptions({ ...process.env, COPILOT_HOME: home, BRIDGE_WORKSPACE_DIR: workspace }),
    useLoggedInUser: false, baseDirectory: join(home, "session-state"), logLevel: "error",
  });
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

  const configFor = (model: string, forResume = false, identity?: string): AgentSessionConfig => {
    const settingsStore = identity ? createSettingsStore(setupTestDb()) : undefined;
    settingsStore?.updateSettings({ identity });
    const bridgeConfig = buildSessionConfig({
      deps: { config: { sessionMcpServers: {} }, clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" }, settingsStore },
      options: { forResume },
      callbacks: { resolveEffectiveSessionCwd: () => cwd, getCopilotHome: () => home },
    });
    // Keep every prompt-shaping field; drop only what needs network access or real tools.
    delete bridgeConfig.githubMcpToolConfig;
    return {
      ...bridgeConfig,
      mcpServers: {},
      skillDirectories: [],
      model,
      provider: { type: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "completions" },
    };
  };
  return { backend, configFor, requests, cleanup };
}

// The CLI renders a different tool_efficiency per model family; the transform must keep it.
const MODEL_TOOL_GUIDANCE: Record<string, string> = {
  "gpt-5-mini": "use grep, glob, view, edit yourself",
  "claude-sonnet-4.5": "use grep, glob, view, edit yourself",
  "gpt-6-astra": "use rg, glob, view, apply_patch yourself",
};

function assertBridgePrompt(prompt: string, model: string) {
  expect(prompt).toContain(MODEL_TOOL_GUIDANCE[model]);
  expect(prompt.startsWith(`${DEFAULT_IDENTITY}\n\n<response_style>`)).toBe(true);
  expect(prompt).not.toContain("You are GitHub Copilot");
  expect(prompt).not.toContain("You are an interactive tool that helps users with software engineering tasks.");
  // Other identity-group children the Bridge keeps.
  expect(prompt).toContain("# Search and delegation");
  expect(prompt).toContain(`Powered by <model name="${model}"`);

  // The identity group's children survive; the Bridge owns tone.
  expect(prompt).toContain("# Tool usage efficiency");
  expect(prompt).not.toContain("Your output appears in a command-line interface");
  expect(prompt).not.toContain("100 words");
  expect(prompt.split("<response_style>").length - 1).toBe(1);
  expect(prompt.indexOf("<response_style>")).toBeLessThan(prompt.indexOf("# Tool usage efficiency"));

  expect(prompt).not.toContain("<git_commit_trailer>");
  expect(prompt).not.toMatch(/Co-authored-by/i);

  const lifecycle = prompt.indexOf("**Sub-agent lifecycle**");
  const browser = prompt.indexOf("<browser_escalation>");
  expect(lifecycle).toBeGreaterThan(-1);
  expect(browser).toBeGreaterThan(lifecycle);
  expect(browser).toBeLessThan(prompt.indexOf("<system_notifications>"));

  expect(prompt).not.toContain("Respond concisely to the user");
  // The session folder has no instruction files and is outside any git work tree.
  expect(prompt).not.toContain("<custom_instruction>");
  expect(prompt.split("<asking_and_proceeding>").length - 1).toBe(1);
  expect(prompt).toContain("<task_completion>");
  expect(prompt).toContain("<response_quality>");
}

describe("native Bridge system prompt", () => {
  it("assembles the intended sections on create and cold resume for each model family", async ({ signal }) => {
    const { backend, configFor, requests, cleanup } = await fixture(signal);
    try {
      for (const model of Object.keys(MODEL_TOOL_GUIDANCE)) {
        const session = await backend.createSession(configFor(model));
        await session.sendAndWait({ prompt: "Return the fixture response." }, null);
        assertBridgePrompt(systemPromptOf(requests.at(-1)), model);
        await session.release();

        const resumed = await backend.resumeSession(session.sessionId, configFor(model, true));
        await resumed.sendAndWait({ prompt: "Return the fixture response after cold resume." }, null);
        assertBridgePrompt(systemPromptOf(requests.at(-1)), model);
        await resumed.release();
      }
    } finally { await cleanup(); }
  });

  it("keeps a custom identity intact even when it repeats the runtime mode statement", async ({ signal }) => {
    const { backend, configFor, requests, cleanup } = await fixture(signal);
    const statement = "You are an interactive tool that helps users with software engineering tasks.";
    const identity = `You are Tim's assistant. ${statement}`;
    try {
      const session = await backend.createSession(configFor("gpt-5-mini", false, identity));
      await session.sendAndWait({ prompt: "Return the fixture response." }, null);
      const prompt = systemPromptOf(requests.at(-1));
      expect(prompt.startsWith(`${identity}\n\n<response_style>`)).toBe(true);
      expect(prompt.split(statement).length - 1).toBe(1);
      await session.release();
    } finally { await cleanup(); }
  });
});
