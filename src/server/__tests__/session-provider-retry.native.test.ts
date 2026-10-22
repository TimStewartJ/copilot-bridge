import { CopilotClient } from "@github/copilot-sdk";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import type { AgentSession, AgentSessionConfig } from "../agent-backend/types.js";
import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { buildSessionConfig } from "../session-config-builder.js";
import { createEventBusRegistry } from "../event-bus.js";
import { SessionAgentRegistry } from "../session-agent-registry.js";
import { SessionRunStateController } from "../session-run-state-controller.js";
import { SessionRunner, type SessionRunnerDeps } from "../session-runner.js";
import { PROVIDER_RETRY_DELAY_MS, PROVIDER_RETRY_PROMPT } from "../session-provider-retry.js";
import { createSessionContextStore } from "../session-context-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { isRecord } from "../../shared/is-record.js";
import { createTestBus, makeTestDir, registerTestAppCleanup, setupTestDb } from "./helpers.js";
import { stopCopilotRuntime } from "./copilot-native-runtime.js";

let runtime: { home: string; backend: CopilotBackend } | undefined;

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-provider-retry-native-"));
  const client = new CopilotClient({
    ...buildCopilotClientOptions({ ...process.env, COPILOT_HOME: home, BRIDGE_WORKSPACE_DIR: join(home, "workspace") }),
    useLoggedInUser: false, baseDirectory: home, logLevel: "error",
  });
  runtime = { home, backend: new CopilotBackend(client, { localStdioOwnership: true }) };
  await runtime.backend.start();
});

afterAll(async () => {
  if (runtime) await stopCopilotRuntime(runtime.backend, runtime.home);
});

async function fixture(signal: AbortSignal) {
  if (!runtime) throw new Error("CLI runtime did not start");
  const { home, backend } = runtime;
  const requests: Array<{ at: number; body: string; status: number }> = [];
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
      const status = requests.length === 0 ? 400 : 200;
      requests.push({ at: Date.now(), body, status });
      if (status === 400) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "internal server error", type: "internal_server_error" } }));
        return;
      }
      response.setHeader("Content-Type", "text/event-stream");
      response.end(`data: ${JSON.stringify({
        id: "fixture", object: "chat.completion.chunk", created: 0, model: input.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "Recovered response." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 },
      })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback address");
  const bridgeConfig = buildSessionConfig({
    deps: { config: { sessionMcpServers: {} }, clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" } },
    callbacks: { resolveEffectiveSessionCwd: () => makeTestDir("provider-retry-cwd"), getCopilotHome: () => home },
  });
  delete bridgeConfig.githubMcpToolConfig;
  const config: AgentSessionConfig = {
    ...bridgeConfig, mcpServers: {}, skillDirectories: [], model: "fake-retry",
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "completions" },
    modelCapabilities: { limits: { max_prompt_tokens: 900_000, max_context_window_tokens: 1_000_000 } },
  };
  const session = await backend.createSession(config);
  const sessionId = session.sessionId;
  const sessionObjects = new Map<string, AgentSession>([[sessionId, session]]);
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const bus = eventBusRegistry.getOrCreateBus(sessionId);
  const agentRegistry = new SessionAgentRegistry({ globalBus, getLiveSession: (id) => sessionObjects.get(id) });
  const runStateController = new SessionRunStateController({
    globalBus, cancelPendingInteractions: () => {},
    promptDeliveryAbortedMessage: "Stopped", promptDeliveryShutdownMessage: "Shutdown",
    persistTerminalOverlay: () => {}, clearTerminalOverlay: () => {},
  });
  const telemetryStore = createTelemetryStore(db);
  const deps: SessionRunnerDeps = {
    getBackend: () => backend, sessionObjects, mcpStatus: new Map(), activeRunControllers: new Map(),
    runStateController, agentRegistry, eventBusRegistry, globalBus, telemetryStore,
    sessionContextStore: createSessionContextStore(db),
    isSessionBusy: (id) => runStateController.getSessionRunState(id) !== "idle",
    hasPlan: () => false, getSessionStateDir: (id) => join(home, "session-state", id),
    buildSessionConfig: () => config, awaitPendingSessionCreation: async () => undefined,
    beginSessionResume: async (id) => ({ sessionId: id, token: Symbol() }), endSessionResume: () => {},
    resumeSessionWithTimeout: (_backend, _id, resume) => resume,
    notifySessionCapacityChanged: () => {}, findLinkedTask: () => undefined, lookupGroupNotes: () => null,
    persistAndRouteAttachments: () => undefined,
    cacheResumedSession: async (_id, resumed: AgentSession) => resumed,
    waitForSessionToolInitialization: () => true, abandonCachedSession: async () => {},
    abortSession: async () => { await session.abort(); return true; },
    markCachedSessionForEviction: () => {}, deferMcpStatusSessionEviction: () => {}, flushPendingSessionEviction: () => {},
    getPendingUserInputCount: () => 0, getPendingInteractionCount: () => 0, autoAnswerOverdueInteractions: async () => {},
    answerQuestionUnshown: () => undefined, recordPendingInteractionEvent: () => {},
    recordSessionAttention: () => {}, maybeAutoNameSession: () => {},
  };
  const runner = new SessionRunner(deps);
  const cleanup = registerTestAppCleanup(async () => {
    runner.cancelProviderRetry(sessionId);
    deps.activeRunControllers.get(sessionId)?.completeAborted("");
    await runner.waitForWatchdogIdle(sessionId);
    runner.detachSession(sessionId, session);
    agentRegistry.dispose();
    await session.abort();
    await session.release();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  signal.throwIfAborted();
  return { runner, sessionId, bus, requests, telemetryStore, cleanup, home, db };
}

describe("native provider retry", () => {
  it("recovers from a real CLI terminal 400 with one hidden continuation after the cooldown", async ({ signal }) => {
    const f = await fixture(signal);
    try {
      const run = f.runner.startWorkRun(f.sessionId, "Return the fixture answer.");
      await run.completion;
      await f.runner.waitForWatchdogIdle(f.sessionId);
      expect(f.bus.getTerminalState()).toMatchObject({ terminalType: "done", finalContent: "Recovered response." });
      expect(f.requests.map((r) => r.status)).toEqual([400, 200]);
      expect(f.requests[1].at - f.requests[0].at).toBeGreaterThanOrEqual(PROVIDER_RETRY_DELAY_MS);
      expect(f.requests[1].body).toContain(PROVIDER_RETRY_PROMPT);
      const events = (await readFile(join(f.home, "session-state", f.sessionId, "events.jsonl"), "utf8"))
        .split(/\r?\n/).filter(Boolean).map((line): unknown => JSON.parse(line)).filter(isRecord);
      const prompts = events.filter((event) => event.type === "user.message").map((event) => event.data);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toMatchObject({ source: "system", content: PROVIDER_RETRY_PROMPT });
      expect(events.filter((event) => event.type === "system.message").length).toBeGreaterThan(0);
      expect(f.db.prepare(
        "SELECT json_extract(modelUsageJson, '$.inputTokens') AS inputTokens FROM session_context_events WHERE sessionId = ? AND type = 'context_snapshot' AND modelUsageJson IS NOT NULL",
      ).all(f.sessionId)).toContainEqual({ inputTokens: 123 });
      expect(f.telemetryStore.querySpans({ name: "session.provider.error", sessionId: f.sessionId })[0]?.metadata)
        .toMatchObject({ statusCode: 400, category: "internal_server_error" });
    } finally { await f.cleanup(); }
  });

  it("cancels the real CLI cooldown without making a second provider request", async ({ signal }) => {
    const f = await fixture(signal);
    let cancelled = false;
    const unsubscribe = f.bus.subscribe((event) => {
      if (event.type === "provider_retry" && isRecord(event.providerRetry) && event.providerRetry.phase === "waiting") {
        queueMicrotask(() => { cancelled = f.runner.cancelProviderRetry(f.sessionId); });
      }
    });
    try {
      const run = f.runner.startWorkRun(f.sessionId, "Return the fixture answer.");
      await run.completion;
      expect(cancelled).toBe(true);
      expect(f.bus.getTerminalState().terminalType).toBe("aborted");
      expect(f.requests.map((r) => r.status)).toEqual([400]);
    } finally { unsubscribe(); await f.cleanup(); }
  });
});
