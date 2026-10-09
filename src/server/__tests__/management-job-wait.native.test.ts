import { CopilotClient } from "@github/copilot-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isRecord } from "../../shared/is-record.js";
import type { AppContext } from "../app-context.js";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { createNativeBridgeTools } from "../bridge-native-tools.js";
import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { openMemoryDatabase } from "../db.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { managementJobDeliveryId } from "../management-job-delivery.js";
import { createManagementJobStore } from "../management-job-store.js";
import { registerManagementJobTools } from "../tools/management-job-tools.js";
import { makeTestDir, registerTestAppCleanup } from "./helpers.js";

function completionSignal() {
  let complete = () => {};
  const promise = new Promise<void>((resolve) => { complete = resolve; });
  return { promise, complete };
}

async function fixture(signal: AbortSignal) {
  const home = makeTestDir("native-management-job-wait");
  const cwd = join(home, "workspace");
  const db = openMemoryDatabase();
  const store = createManagementJobStore(db, { dataDir: home });
  const prompts = createDeferredPromptStore(db);
  const ctx = { managementJobStore: store, deferredPromptStore: prompts } as AppContext;
  const registry = new BridgeToolsMcpServer(ctx);
  registerManagementJobTools(registry, ctx);
  const tools = createNativeBridgeTools(registry.getToolDefinitions());
  const wait = tools.find((tool) => tool.name === "management_job_wait");
  if (!wait?.handler) throw new Error("Missing native wait tool");
  const handler = wait.handler;
  const entered = completionSignal();
  const settled = completionSignal();
  let waitStarted = false;
  wait.handler = async (args, invocation) => {
    waitStarted = true;
    entered.complete();
    try { return await handler(args, invocation); }
    finally { settled.complete(); }
  };
  const polled = completionSignal();
  let reads = 0;
  const get = store.get.bind(store);
  vi.spyOn(store, "get").mockImplementation((id) => {
    if (++reads >= 3) polled.complete();
    return get(id);
  });
  let jobId = "";
  const requests: Record<string, unknown>[] = [];
  const providerErrors: string[] = [];
  const provider = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      providerErrors.push(`Unexpected request ${request.method} ${request.url}`);
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const input: unknown = JSON.parse(body);
      if (!isRecord(input)) { response.writeHead(400).end(); return; }
      requests.push(input);
      const name = requests.length === 1 ? "management_job_wait" : "task_complete";
      const message = requests.length <= 2
        ? {
          role: "assistant", content: null,
          tool_calls: [{
            id: `fixture-call-${requests.length}`, type: "function",
            function: {
              name,
              arguments: JSON.stringify(name === "management_job_wait"
                ? { jobId } : { summary: "Preview fixture complete." }),
            },
          }],
        }
        : { role: "assistant", content: "Preview fixture complete." };
      const finishReason = requests.length <= 2 ? "tool_calls" : "stop";
      if (input.stream === true) {
        response.setHeader("Content-Type", "text/event-stream");
        response.end(`data: ${JSON.stringify({
          id: "wait-fixture", object: "chat.completion.chunk", created: 0, model: input.model,
          choices: [{ index: 0, delta: message, finish_reason: finishReason }],
        })}\n\ndata: [DONE]\n\n`);
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          id: "wait-fixture", object: "chat.completion", created: 0, model: input.model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
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
    if (closing) throw new Error("Native wait fixture is closed");
    await start();
  };
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
    closing = true;
    try { await setup; }
    finally {
      try { await backend.stop(); }
      finally {
        if (waitStarted) await settled.promise;
        provider.closeAllConnections();
        if (provider.listening) await new Promise<void>((resolve, reject) => {
          provider.close((error) => error ? reject(error) : resolve());
        });
        db.close();
      }
    }
  });
  await setup;
  signal.throwIfAborted();
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback provider address");
  const session = await backend.createSession({
    model: "gpt-5-mini", workingDirectory: cwd,
    memory: { enabled: false }, enableConfigDiscovery: false, skillDirectories: [], instructionDirectories: [],
    mcpServers: {}, tools, availableTools: ["custom:*", "task_complete"],
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "completions" },
  });
  const job = store.enqueue("staging_preview", { stagingDir: cwd }, { originSessionId: session.sessionId });
  jobId = job.id;
  const terminal = completionSignal();
  let continuations = 0;
  session.on((event) => {
    if (event.type === "user.message" && isRecord(event.data) && event.data.source === "autopilot") continuations++;
    if (event.type === "session.idle" || event.type === "session.task_complete" || event.type === "abort") terminal.complete();
  });
  await session.setSendMode({ mode: "autopilot" });
  await session.send({ prompt: "Wait for the synthetic preview, then mark the task complete." });
  await entered.promise;
  await polled.promise;
  return { session, store, prompts, job, requests, providerErrors, settled, terminal, cleanup, continuations: () => continuations };
}

describe("native Autopilot management job waits", () => {
  it("makes no additional model requests or continuations while a preview tool is pending", async ({ signal }) => {
    const f = await fixture(signal);
    try {
      expect(f.requests).toHaveLength(1);
      expect(await f.session.getSendMode?.()).toBe("autopilot");
      expect(await f.session.getActivity()).toMatchObject({ processing: true });
      expect(f.continuations()).toBe(0);
      if (!f.job.logPath) throw new Error("Missing fixture log path");
      await writeFile(f.job.logPath, "native preview validation log\n");
      f.store.succeed(f.job.id, { previewUrl: "https://bridge.example/staging/native-wait/" });
      await f.settled.promise;
      await f.terminal.promise;
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests[1])).toContain("https://bridge.example/staging/native-wait/");
      expect(JSON.stringify(f.requests[1])).toContain("native preview validation log");
      expect(f.continuations()).toBe(0);
      expect(f.prompts.get(managementJobDeliveryId(f.job.id))?.status).toBe("completed");
      expect(f.providerErrors).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("propagates native Stop into the waiter and never wakes the chat when the job later finishes", async ({ signal }) => {
    const f = await fixture(signal);
    try {
      await f.session.abort();
      await f.settled.promise;
      await f.terminal.promise;
      expect(f.store.get(f.job.id)?.status).toBe("queued");
      f.store.succeed(f.job.id, { previewUrl: "https://bridge.example/staging/stopped/" });
      expect(f.store.reconcileResultDeliveries()).toBe(0);
      expect(f.prompts.get(managementJobDeliveryId(f.job.id))?.status).toBe("cancelled");
      expect(f.requests).toHaveLength(1);
      expect(f.continuations()).toBe(0);
      expect(f.providerErrors).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
