import { CopilotClient } from "@github/copilot-sdk";
import { mkdir, readdir, readFile } from "node:fs/promises";
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
import { PROMPT_PROFILE_DEFINITIONS } from "../prompt-profiles.js";
import type { PromptProfileId } from "../../shared/prompt-profiles.js";
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

  const configFor = (
    model: string,
    forResume = false,
    identity?: string,
    promptProfile: PromptProfileId = "engineer",
  ): AgentSessionConfig => {
    const settingsStore = identity ? createSettingsStore(setupTestDb()) : undefined;
    settingsStore?.updateSettings({ identity });
    const bridgeConfig = buildSessionConfig({
      deps: { config: { sessionMcpServers: {} }, clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" }, settingsStore },
      options: { forResume, promptProfile },
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
  return { backend, configFor, requests, cleanup, home };
}

function lastUserMessageOf(request: Record<string, unknown> | undefined): string {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const user = messages.filter((message: unknown) => isRecord(message) && message.role === "user").at(-1);
  if (!isRecord(user)) return "";
  if (typeof user.content === "string") return user.content;
  return Array.isArray(user.content)
    ? user.content.map((part: unknown) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("")
    : "";
}

async function findFile(dir: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

// The CLI renders a different tool_efficiency per model family; the transform must keep it.
const MODEL_TOOL_GUIDANCE: Record<string, string> = {
  "gpt-5-mini": "use grep, glob, view, edit yourself",
  "claude-sonnet-4.5": "use grep, glob, view, edit yourself",
  "gpt-6-astra": "use rg, glob, view, apply_patch yourself",
};

const PROFILE_BLOCKS: Record<PromptProfileId, { communication: string; approach: string }> = {
  engineer: { communication: "<engineering_reports>", approach: "<engineering_approach>" },
  assistant: { communication: "<conversation_style>", approach: "<assistant_approach>" },
  monitor: { communication: "<monitor_report>", approach: "<monitor_approach>" },
};

function assertProfile(prompt: string, promptProfile: PromptProfileId) {
  const definition = PROMPT_PROFILE_DEFINITIONS[promptProfile];
  expect(prompt.startsWith(`${DEFAULT_IDENTITY}\n\n${definition.role}\n\n<response_style>`)).toBe(true);
  // Communication follows the response style inside the tone section, before tool guidance.
  const communication = prompt.indexOf(PROFILE_BLOCKS[promptProfile].communication);
  expect(communication).toBeGreaterThan(prompt.indexOf("</response_style>"));
  // Shared writing rules sit between the style and the profile's communication rules.
  expect(prompt.split("<writing>").length - 1).toBe(1);
  expect(prompt.indexOf("<writing>")).toBeGreaterThan(prompt.indexOf("</response_style>"));
  expect(prompt.indexOf("</writing>")).toBeLessThan(communication);
  expect(communication).toBeLessThan(prompt.indexOf("# Tool usage efficiency"));
  // The approach extends the CLI guidelines section, which stays intact.
  const approach = prompt.indexOf(PROFILE_BLOCKS[promptProfile].approach);
  expect(approach).toBeGreaterThan(prompt.indexOf("</tips_and_tricks>"));
  expect(approach).toBeLessThan(prompt.indexOf("<environment_limitations>"));
  for (const [other, blocks] of Object.entries(PROFILE_BLOCKS)) {
    if (other === promptProfile) continue;
    expect(prompt).not.toContain(blocks.communication);
    expect(prompt).not.toContain(blocks.approach);
  }
  if (definition.keepCodingRules) {
    expect(prompt).toContain("<rules_for_code_changes>");
  } else {
    expect(prompt).not.toContain("<rules_for_code_changes>");
    expect(prompt).not.toContain("<code_change_instructions>");
  }
}

function assertBridgePrompt(prompt: string, model: string, promptProfile: PromptProfileId = "engineer") {
  expect(prompt).toContain(MODEL_TOOL_GUIDANCE[model]);
  assertProfile(prompt, promptProfile);
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

  it("assembles the Assistant and Monitor profiles on create and cold resume", async ({ signal }) => {
    const { backend, configFor, requests, cleanup } = await fixture(signal);
    try {
      for (const model of ["claude-sonnet-4.5", "gpt-6-astra"]) {
        for (const promptProfile of ["assistant", "monitor"] as const) {
          const session = await backend.createSession(configFor(model, false, undefined, promptProfile));
          await session.sendAndWait({ prompt: "Return the fixture response." }, null);
          assertBridgePrompt(systemPromptOf(requests.at(-1)), model, promptProfile);
          await session.release();

          const resumed = await backend.resumeSession(session.sessionId, configFor(model, true, undefined, promptProfile));
          await resumed.sendAndWait({ prompt: "Return the fixture response after cold resume." }, null);
          assertBridgePrompt(systemPromptOf(requests.at(-1)), model, promptProfile);
          await resumed.release();
        }
      }
    } finally { await cleanup(); }
  });

  it("gives the model the bridge_context block while the stored user message keeps only the typed text", async ({ signal }) => {
    const { backend, configFor, requests, cleanup, home } = await fixture(signal);
    const block = "<bridge_context>\n<task_state>\nTask: \"Fixture\" (status: active, kind: task)\n</task_state>\n</bridge_context>";
    try {
      const session = await backend.createSession(configFor("gpt-5-mini"));
      await session.sendAndWait({ prompt: `${block}\n\nWhat is next?`, displayPrompt: "What is next?" }, null);
      const sent = lastUserMessageOf(requests.at(-1));
      expect(sent).toContain(block);
      expect(sent).toContain("What is next?");
      expect(systemPromptOf(requests.at(-1))).not.toContain("<task_state>");
      await session.release();

      const eventsFile = await findFile(home, "events.jsonl");
      expect(eventsFile).toBeDefined();
      const events = (await readFile(eventsFile!, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const userMessage = events.find((event) => event.type === "user.message");
      expect(userMessage?.data?.content).toBe("What is next?");
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
      expect(prompt.startsWith(`${identity}\n\n${PROMPT_PROFILE_DEFINITIONS.engineer.role}\n\n<response_style>`)).toBe(true);
      expect(prompt.split(statement).length - 1).toBe(1);
      await session.release();
    } finally { await cleanup(); }
  });
});
