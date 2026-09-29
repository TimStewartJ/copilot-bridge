import { CopilotClient } from "@github/copilot-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../shared/is-record.js";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import type { AgentSession, AgentSessionConfig } from "../agent-backend/types.js";
import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { buildSessionConfig } from "../session-config-builder.js";
import { ImageBudgetController } from "../image-budget.js";
import type { ImageBudgetSettings } from "../../shared/image-budget.js";
import { makeTestDir, registerTestAppCleanup } from "./helpers.js";

// Drives the real Copilot CLI against a local model server that rejects any request over a byte cap
// with a bodyless 400, the way Google Vertex rejects oversized Claude requests. The CLI cannot
// recover from that on its own; the image budget must compact before a request gets there.
// The server speaks both the OpenAI completions wire and the Anthropic messages wire, because
// the CLI measures and shrinks requests differently on each (CLI 1.0.89 shrinks Claude requests
// to about 32 MiB before sending, which is still above Vertex's 30 MB).

type Wire = "completions" | "anthropic";
const MODELS: Record<Wire, string> = { completions: "fake-vision", anthropic: "claude-fake-vision" };
const MODEL = MODELS.completions;
const IMAGE_SIDE = 500; // 750 KB of noise, about 1 MB as base64

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG of random pixels, which does not compress, so its size is predictable. */
function noisePng(side: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < side; y++) rows.push(Buffer.concat([Buffer.from([0]), randomBytes(side * 3)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

interface ModelRequest { bytes: number; summary: boolean; status: number; text: string }

type ModelAction = { text: string } | { views: string[] };

function writeCompletionsReply(response: ServerResponse, input: Record<string, unknown>, action: ModelAction, nextId: () => string) {
  const message: Record<string, unknown> = "text" in action
    ? { role: "assistant", content: action.text }
    : {
        role: "assistant",
        content: null,
        tool_calls: action.views.map((path) => ({
          id: nextId(),
          type: "function",
          function: { name: "view", arguments: JSON.stringify({ path }) },
        })),
      };
  const finish = "text" in action ? "stop" : "tool_calls";
  if (input.stream === true) {
    response.setHeader("Content-Type", "text/event-stream");
    response.end(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 0, model: input.model,
      choices: [{ index: 0, delta: message, finish_reason: finish }],
    })}\n\ndata: [DONE]\n\n`);
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      id: "fixture", object: "chat.completion", created: 0, model: input.model,
      choices: [{ index: 0, message, finish_reason: finish }],
    }));
  }
}

function writeAnthropicReply(response: ServerResponse, input: Record<string, unknown>, action: ModelAction, nextId: () => string) {
  const blocks = "text" in action
    ? [{ type: "text", text: action.text }]
    : action.views.map((path) => ({ type: "tool_use", id: nextId(), name: "view", input: { path } }));
  const stop = "text" in action ? "end_turn" : "tool_use";
  const usage = { input_tokens: 100, output_tokens: 10 };
  if (input.stream !== true) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      id: "msg_fixture", type: "message", role: "assistant", model: input.model, content: blocks, stop_reason: stop, stop_sequence: null, usage,
    }));
    return;
  }
  const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = event("message_start", {
    message: { id: "msg_fixture", type: "message", role: "assistant", model: input.model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      out += event("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += event("content_block_delta", { index, delta: { type: "text_delta", text: (block as { text: string }).text } });
    } else {
      const { id, name, input: args } = block as { id: string; name: string; input: unknown };
      out += event("content_block_start", { index, content_block: { type: "tool_use", id, name, input: {} } });
      out += event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } });
    }
    out += event("content_block_stop", { index });
  });
  out += event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
  out += event("message_stop", {});
  response.setHeader("Content-Type", "text/event-stream");
  response.end(out);
}

async function fixture(signal: AbortSignal, options: { capBytes: number; views: number; perTurn: number; budget: ImageBudgetSettings; wire?: Wire }) {
  const wire = options.wire ?? "completions";
  const model = MODELS[wire];
  const path = wire === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const home = makeTestDir("image-budget-native");
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const imagePaths: string[] = [];
  for (let i = 0; i < options.views; i++) {
    const path = join(cwd, `noise-${i}.png`);
    await writeFile(path, noisePng(IMAGE_SIDE));
    imagePaths.push(path);
  }

  const requests: ModelRequest[] = [];
  let issued = 0;
  let callId = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== path) {
        response.writeHead(404).end();
        return;
      }
      const input: unknown = JSON.parse(body);
      if (!isRecord(input) || !Array.isArray(input.messages)) { response.writeHead(400).end(); return; }
      const last = JSON.stringify(input.messages.at(-1) ?? "");
      const summary = /history is being compacted|summary of the conversation/i.test(last);
      const bytes = Buffer.byteLength(body);
      const text = body.length > 400_000 ? body.replace(/"(data:image\/[^"]+|[A-Za-z0-9+/=]{100000,})"/g, "\"<image>\"") : body;
      if (bytes > options.capBytes) {
        requests.push({ bytes, summary, status: 400, text });
        response.writeHead(400).end();
        return;
      }
      requests.push({ bytes, summary, status: 200, text });
      let action: ModelAction;
      if (summary) {
        action = { text: "<overview>Viewed noise images one after another.</overview>" };
      } else if (issued < options.views) {
        const batch = imagePaths.slice(issued, issued + options.perTurn);
        issued += batch.length;
        action = { views: batch };
      } else {
        action = { text: "Viewed every image." };
      }
      const nextId = () => `call_${++callId}`;
      if (wire === "anthropic") writeAnthropicReply(response, input, action, nextId);
      else writeCompletionsReply(response, input, action, nextId);
    });
  });

  const client = new CopilotClient({
    ...buildCopilotClientOptions({ ...process.env, COPILOT_HOME: home, BRIDGE_WORKSPACE_DIR: join(home, "bridge-workspace") }),
    useLoggedInUser: false, baseDirectory: join(home, "session-state"), logLevel: "error",
  });
  const backend = new CopilotBackend(client);
  const setup = (async () => {
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
        if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  });
  await setup;
  signal.throwIfAborted();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback address");

  const eventsPaths = new Map<string, string>();
  let live: AgentSession | undefined;
  let turnRunning = false;
  const continuations: Promise<unknown>[] = [];
  // The production controller, with a host backed by the raw session instead of SessionManager.
  const controller = new ImageBudgetController({
    getSettings: () => options.budget,
    getEventsPath: (sessionId) => eventsPaths.get(sessionId) ?? join(home, "missing.jsonl"),
    hold: () => true,
    runningTurn: () => (turnRunning ? "stoppable" : "none"),
    stopTurn: async () => { await live?.abort(); },
    finish: (_sessionId, _session, { continuation }) => {
      if (continuation && live) continuations.push(send(live, continuation.prompt));
    },
  });
  const send = async (session: AgentSession, prompt: string) => {
    turnRunning = true;
    try {
      return await session.sendAndWait({ prompt }, null);
    } finally {
      turnRunning = false;
    }
  };
  const bridgeConfig = buildSessionConfig({
    deps: { config: { sessionMcpServers: {} }, clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" } },
    callbacks: { resolveEffectiveSessionCwd: () => cwd, getCopilotHome: () => home },
  });
  delete bridgeConfig.githubMcpToolConfig;
  const config: AgentSessionConfig = {
    ...bridgeConfig,
    mcpServers: {},
    skillDirectories: [],
    model,
    provider: wire === "anthropic"
      ? { type: "anthropic", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "fixture" }
      : { type: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "completions" },
    modelCapabilities: { supports: { vision: true }, limits: { max_prompt_tokens: 900_000, max_context_window_tokens: 1_000_000 } },
  };

  const run = async () => {
    const session: AgentSession = await backend.createSession(config);
    live = session;
    eventsPaths.set(session.sessionId, join(home, "session-state", session.sessionId, "events.jsonl"));
    const unsubscribe = session.on((event) => controller.observe(session.sessionId, session, event));
    controller.attach(session.sessionId, session);
    const errors: string[] = [];
    let aborts = 0;
    session.on((event: any) => {
      if (event?.type === "session.error") errors.push(String(event.data?.message));
      if (event?.type === "abort") aborts += 1;
    });
    let reply: unknown;
    try {
      reply = await send(session, "View the images you are given, one batch at a time.");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    // Each pause stops the current run and starts the next one; wait until no pause is left running.
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const pending = continuations.shift();
      if (!pending) {
        if (!controller.isPausing(session.sessionId) && !turnRunning) break;
        continue;
      }
      try {
        reply = await pending;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    unsubscribe();
    controller.detach(session.sessionId, session);
    await session.release();
    return { reply: (reply as any)?.data?.content as string | undefined, errors: errors.filter((error) => !/abort/i.test(error)), aborts };
  };
  return { run, requests, cleanup };
}

const IMAGE_BYTES = Math.ceil((IMAGE_SIDE * (IMAGE_SIDE * 3 + 1)) / 3) * 4;

describe("native image budget", () => {
  // When this starts failing, the CLI recovers by itself and image-budget.ts can be removed.
  it("without a ceiling the CLI cannot get past a provider's byte cap", async ({ signal }) => {
    const { run, requests, cleanup } = await fixture(signal, {
      capBytes: 9 * IMAGE_BYTES, views: 12, perTurn: 1, budget: { ceilingsMb: {} },
    });
    try {
      const { reply, errors } = await run();
      expect(reply).not.toBe("Viewed every image.");
      expect(errors.join("\n")).toMatch(/400/);
      expect(requests.some((request) => request.status === 400)).toBe(true);
      expect(requests.some((request) => request.summary)).toBe(false);
    } finally { await cleanup(); }
  });

  it("pauses before the cap, compacts, continues, and finishes", async ({ signal }) => {
    const capBytes = 9 * IMAGE_BYTES;
    const { run, requests, cleanup } = await fixture(signal, {
      capBytes, views: 12, perTurn: 1, budget: { ceilingsMb: { [MODEL]: capBytes / 1_000_000 } },
    });
    try {
      const { reply, errors, aborts } = await run();
      expect(errors).toEqual([]);
      expect(reply).toBe("Viewed every image.");
      expect(aborts).toBeGreaterThanOrEqual(1);
      expect(requests.every((request) => request.status === 200)).toBe(true);
      expect(requests.filter((request) => request.summary).length).toBeGreaterThanOrEqual(1);
      expect(requests.some((request) => request.text.includes("Bridge paused your previous turn"))).toBe(true);
      expect(Math.max(...requests.map((request) => request.bytes))).toBeLessThanOrEqual(capBytes);
    } finally { await cleanup(); }
  });

  it("keeps up with three images per turn", async ({ signal }) => {
    const capBytes = 12 * IMAGE_BYTES;
    const { run, requests, cleanup } = await fixture(signal, {
      capBytes, views: 15, perTurn: 3, budget: { ceilingsMb: { [MODEL]: capBytes / 1_000_000 } },
    });
    try {
      const { reply, errors } = await run();
      expect(errors).toEqual([]);
      expect(reply).toBe("Viewed every image.");
      expect(requests.every((request) => request.status === 200)).toBe(true);
      expect(requests.filter((request) => request.summary).length).toBeGreaterThanOrEqual(1);
    } finally { await cleanup(); }
  });

  // Production Claude goes through the Anthropic messages wire. CLI 1.0.89 shrinks those requests to
  // about 32 MiB before sending, but still gives up on a bodyless 400 below that. When this starts
  // failing, the CLI recovers from a provider cap on the Claude path too.
  it("without a ceiling the CLI cannot get past a byte cap on the Claude messages wire", async ({ signal }) => {
    const { run, requests, cleanup } = await fixture(signal, {
      wire: "anthropic", capBytes: 9 * IMAGE_BYTES, views: 12, perTurn: 1, budget: { ceilingsMb: {} },
    });
    try {
      const { reply, errors } = await run();
      expect(reply).not.toBe("Viewed every image.");
      expect(errors.join("\n")).toMatch(/400/);
      expect(requests.some((request) => request.status === 400)).toBe(true);
      expect(requests.some((request) => request.summary)).toBe(false);
    } finally { await cleanup(); }
  });

  it("pauses before the cap and finishes on the Claude messages wire", async ({ signal }) => {
    const capBytes = 9 * IMAGE_BYTES;
    const { run, requests, cleanup } = await fixture(signal, {
      wire: "anthropic", capBytes, views: 12, perTurn: 1, budget: { ceilingsMb: { [MODELS.anthropic]: capBytes / 1_000_000 } },
    });
    try {
      const { reply, errors } = await run();
      expect(errors).toEqual([]);
      expect(reply).toBe("Viewed every image.");
      expect(requests.every((request) => request.status === 200)).toBe(true);
      expect(requests.filter((request) => request.summary).length).toBeGreaterThanOrEqual(1);
    } finally { await cleanup(); }
  });
});