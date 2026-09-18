import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { AppContext } from "../../app-context.js";
import { makeTestDir } from "../../__tests__/helpers.js";
import { resolveVoicePaths } from "../voice-catalog.js";
import type { VoiceEngine } from "../voice-engine.js";
import type { HelmBridgeFacade } from "../../helm/helm-tools.js";
import { decodePcmBody, encodeAudioFrame, VoiceGateway, type HttpEventSink, type VoiceGatewayHelm } from "../voice-gateway.js";
import type { VoiceInstaller } from "../voice-installer.js";
import { createVoiceRouter } from "../voice-router.js";

const HELM_SESSION_ID = "11111111-2222-4333-8444-555555555555";

function createFakeEngine() {
  const pushed: number[] = [];
  const engine = {
    status: { state: "ready", loaded: ["asr", "turn", "tts"] },
    retain: () => () => undefined,
    onStatus: () => () => undefined,
    ensureCapabilities: vi.fn(async () => undefined),
    openStream: vi.fn(async () => undefined),
    closeStream: vi.fn(),
    pushAudio: (_id: string, pcm: Int16Array) => pushed.push(pcm.length),
    predictTurn: async () => ({ probability: 0.9, ms: 5 }),
    transcribe: async () => ({ text: "hello", ms: 5 }),
    synthesize: () => ({ done: Promise.resolve({ firstChunkMs: 1, totalMs: 1 }), cancel() {} }),
    stop: vi.fn(async () => undefined),
  };
  return { engine: engine as unknown as VoiceEngine, pushed };
}

function createGateway(options: { installed?: boolean; turnCount?: number } = {}) {
  const dataDir = makeTestDir("voice-gateway");
  const paths = resolveVoicePaths({ dataDir, env: {} });
  const { engine, pushed } = createFakeEngine();
  const installer = {
    getStatus: () => ({ installed: options.installed !== false, supported: true, target: "win32-x64", installing: false, assets: [], totalBytes: 0, remainingBytes: 0 }),
    install: vi.fn(async () => undefined),
  } as unknown as VoiceInstaller;
  const listeners = new Set<(event: unknown) => void>();
  const busListeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const sessionManager = {
    startWork: vi.fn(),
    abortSession: vi.fn(async () => true),
    isSessionBusy: vi.fn(() => false),
    warmSession: vi.fn(async () => undefined),
  };
  const ctx = {
    sessionManager,
    settingsStore: { getSettings: () => ({ model: "claude-opus-5" }) },
    globalBus: {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event: unknown) => listeners.forEach((listener) => listener(event)),
    },
    taskStore: { getTask: () => undefined, listTasks: () => [] },
    eventBusRegistry: {
      getBus: () => undefined,
      getOrCreateBus: () => ({
        subscribe: (listener: (event: { type: string }) => void) => {
          busListeners.add(listener);
          return () => busListeners.delete(listener);
        },
      }),
    },
  } as unknown as AppContext;
  const facade: HelmBridgeFacade = {
    listSessions: async () => [],
    markRead: () => undefined,
    setArchived: () => undefined,
    sendMessage: async () => "started",
    createSession: async () => ({ sessionId: "s" }),
  };
  const bound = new Map<string, { requestHandsFree(action: "sleep" | "end"): void }>();
  const helm = {
    isHelmSession: (sessionId) => sessionId === HELM_SESSION_ID,
    bindHandsFree: vi.fn((sessionId, hooks) => {
      bound.set(sessionId, hooks);
      return () => bound.delete(sessionId);
    }),
    isWatched: () => false,
    getTurnCount: vi.fn(() => options.turnCount ?? 0),
    getTurnReasoningEffort: vi.fn((mode) => (mode === "spoken" ? "xhigh" : "max")),
  } satisfies VoiceGatewayHelm;
  const gateway = new VoiceGateway({ ctx, facade, helm, runtime: { paths, engine, installer } });
  const emitBus = (event: { type: string; [key: string]: unknown }) => [...busListeners].forEach((listener) => listener(event));
  return { gateway, engine, pushed, installer, sessionManager, helm, bound, emitBus };
}

class CollectingSink implements HttpEventSink {
  events: any[] = [];
  closed = false;
  send(data: unknown) {
    this.events.push(data);
    return true;
  }
  close() {
    this.closed = true;
  }
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("voice audio framing", () => {
  it("round-trips PCM and frames audio with a header", () => {
    const pcm = new Int16Array([1, -2, 32767, -32768]);
    expect(Array.from(decodePcmBody(Buffer.from(pcm.buffer)))).toEqual([1, -2, 32767, -32768]);
    const frame = encodeAudioFrame({ genId: 7, chunkId: 3, sampleRate: 24000, pcm });
    expect(frame.readUInt8(0)).toBe(1);
    expect(frame.readUInt16LE(2)).toBe(3);
    expect(frame.readUInt32LE(4)).toBe(24000);
    expect(frame.readUInt32LE(8)).toBe(7);
    expect(frame.byteLength).toBe(12 + 8);
  });
});

describe("VoiceGateway HTTP transport", () => {
  it("creates a conversation, starts it and streams audio in order", async () => {
    const { gateway, engine, pushed } = createGateway();
    const { conversationId, token } = gateway.createConversation(HELM_SESSION_ID, { voice: "bm_george" });
    const sink = new CollectingSink();
    expect(gateway.attachHttpEvents(conversationId, "wrong-token", sink)).toBeUndefined();
    const detach = gateway.attachHttpEvents(conversationId, token, sink);
    expect(detach).toBeDefined();
    expect(sink.events[0]).toMatchObject({ type: "hello", conversationId, helmSessionId: HELM_SESSION_ID, transport: "http", settings: { voice: "bm_george" } });

    expect(gateway.acceptHttpControl(conversationId, token, { type: "start", greet: false })).toBe(true);
    await vi.waitFor(() => expect(sink.events).toContainEqual({ type: "state", state: "listening" }));
    expect(engine.openStream).toHaveBeenCalled();

    const frame = (value: number) => Buffer.from(new Int16Array(512).fill(value).buffer);
    gateway.acceptHttpAudio(conversationId, token, 0, frame(1));
    expect(pushed).toEqual([512]);
    gateway.acceptHttpAudio(conversationId, token, 2, frame(3));
    expect(pushed).toEqual([512]);
    gateway.acceptHttpAudio(conversationId, token, 1, frame(2));
    expect(pushed).toEqual([512, 512, 512]);

    gateway.acceptHttpControl(conversationId, token, { type: "ping", t: 42 });
    expect(sink.events.at(-1)).toEqual({ type: "pong", t: 42 });

    gateway.acceptHttpControl(conversationId, token, { type: "control", action: "end" });
    await vi.waitFor(() => expect(sink.closed).toBe(true));
    expect(gateway.getStatus().activeConversations).toBe(0);
    await gateway.shutdown();
  });

  it("serves status and rejects cross-site installs", async () => {
    const { gateway, installer } = createGateway({ installed: false });
    const app = express();
    app.use(express.json());
    app.use("/voice", createVoiceRouter(gateway));
    const status = await request(app).get("/voice/status");
    expect(status.body.install).toMatchObject({ installed: false });
    expect(status.body.voices.some((voice: any) => voice.id === "af_heart")).toBe(true);
    await request(app).post("/voice/install").set("sec-fetch-site", "cross-site").expect(403);
    await request(app).post("/voice/install").set("sec-fetch-site", "same-origin").expect(202);
    expect(installer.install).toHaveBeenCalled();
    await request(app).post("/voice/conversations").send({ helmSessionId: HELM_SESSION_ID }).expect(409);
    await request(app).post("/voice/conversations/unknown/audio?seq=0").set("content-type", "application/octet-stream").send(Buffer.alloc(4)).expect(404);
    await gateway.shutdown();
  });
});

describe("VoiceGateway and Helm", () => {
  async function startConversation(options: { turnCount?: number } = {}) {
    const harness = createGateway(options);
    const { conversationId, token } = harness.gateway.createConversation(HELM_SESSION_ID, {});
    const sink = new CollectingSink();
    harness.gateway.attachHttpEvents(conversationId, token, sink);
    return { ...harness, conversationId, token, sink };
  }

  it("refuses sessions that are not Helm conversations", async () => {
    const { gateway } = createGateway();
    expect(() => gateway.createConversation("00000000-0000-4000-8000-000000000000", {})).toThrow("Helm conversation not found");
    const app = express();
    app.use(express.json());
    app.use("/voice", createVoiceRouter(gateway));
    await request(app).post("/voice/conversations").send({ helmSessionId: "nope" }).expect(404);
    await request(app).post("/voice/conversations").send({}).expect(404);
    const created = await request(app).post("/voice/conversations").send({ helmSessionId: HELM_SESSION_ID }).expect(200);
    expect(created.body.conversationId).toEqual(expect.any(String));
    await gateway.shutdown();
  });

  it("greets a fresh conversation through the Helm session without showing a user message", async () => {
    const { gateway, conversationId, token, sink, sessionManager } = await startConversation();
    gateway.acceptHttpControl(conversationId, token, { type: "start", greet: true });
    await vi.waitFor(() => expect(sessionManager.startWork).toHaveBeenCalledTimes(1));
    const [sessionId, prompt, , options] = sessionManager.startWork.mock.calls[0]!;
    expect(sessionId).toBe(HELM_SESSION_ID);
    expect(prompt).toContain("[hands-free]");
    expect(prompt).toContain("Greet the user");
    expect(options).toEqual({ reasoningEffort: "xhigh", promptSource: "system" });
    expect(sink.events).toContainEqual({ type: "state", state: "thinking" });
    await gateway.shutdown();
  });

  it("resumes a conversation with history quietly", async () => {
    const { gateway, conversationId, token, sink, sessionManager } = await startConversation({ turnCount: 3 });
    gateway.acceptHttpControl(conversationId, token, { type: "start", greet: true });
    await vi.waitFor(() => expect(sink.events).toContainEqual({ type: "state", state: "listening" }));
    expect(sessionManager.startWork).not.toHaveBeenCalled();
    await gateway.shutdown();
  });

  it("answers typed chat messages out loud while hands-free is on", async () => {
    const { gateway, conversationId, token, sink, sessionManager, emitBus } = await startConversation({ turnCount: 1 });
    // Before hands-free has started there is nothing to route through: the chat path handles it.
    expect(gateway.submitTypedText(HELM_SESSION_ID, "what's new?", "client-1")).toBeUndefined();
    gateway.acceptHttpControl(conversationId, token, { type: "start", greet: false });
    await vi.waitFor(() => expect(sink.events).toContainEqual({ type: "state", state: "listening" }));

    expect(gateway.submitTypedText("00000000-0000-4000-8000-000000000000", "hello")).toBeUndefined();
    // Resolves only once the message has reached the session, which is what lets /chat keep its
    // promise that a 202 means the run exists.
    await expect(gateway.submitTypedText(HELM_SESSION_ID, "what's new?", "client-1")).resolves.toEqual({ delivered: true });
    expect(sessionManager.startWork).toHaveBeenCalledTimes(1);
    const [, prompt, , options] = sessionManager.startWork.mock.calls[0]!;
    expect(prompt).toContain("[hands-free]");
    expect(prompt.endsWith("what's new?")).toBe(true);
    // Typed while hands-free is on, but answered out loud: it thinks like a spoken turn.
    expect(options).toEqual({ reasoningEffort: "xhigh", displayPrompt: "what's new?", clientMessageId: "client-1" });

    emitBus({ type: "delta", content: "Two replies are waiting." });
    emitBus({ type: "done" });
    await vi.waitFor(() => expect(sink.events).toContainEqual(expect.objectContaining({ type: "assistant_done", text: "Two replies are waiting." })));
    await gateway.shutdown();
  });

  it("leaves a reply running in the chat when hands-free ends", async () => {
    const { gateway, conversationId, token, sink, sessionManager, bound } = await startConversation({ turnCount: 1 });
    gateway.acceptHttpControl(conversationId, token, { type: "start", greet: false });
    await vi.waitFor(() => expect(sink.events).toContainEqual({ type: "state", state: "listening" }));
    expect(bound.has(HELM_SESSION_ID)).toBe(true);
    await gateway.submitTypedText(HELM_SESSION_ID, "summarize everything");
    expect(sessionManager.startWork).toHaveBeenCalledTimes(1);

    gateway.acceptHttpControl(conversationId, token, { type: "control", action: "end" });
    await vi.waitFor(() => expect(sink.closed).toBe(true));
    expect(sessionManager.abortSession).not.toHaveBeenCalled();
    expect(bound.has(HELM_SESSION_ID)).toBe(false);
    await gateway.shutdown();
  });

  it("reports a typed message that could not reach the session", async () => {
    const { gateway, conversationId, token, sink, sessionManager } = await startConversation({ turnCount: 1 });
    gateway.acceptHttpControl(conversationId, token, { type: "start", greet: false });
    await vi.waitFor(() => expect(sink.events).toContainEqual({ type: "state", state: "listening" }));
    sessionManager.startWork.mockImplementationOnce(() => {
      throw new Error("Bridge is restarting");
    });
    await expect(gateway.submitTypedText(HELM_SESSION_ID, "hello")).resolves.toEqual({
      delivered: false,
      error: "Couldn't reach Copilot: Bridge is restarting",
    });
    await gateway.shutdown();
  });

  it("lets only one hands-free conversation speak for a Helm conversation", async () => {
    const { gateway, sink } = await startConversation();
    gateway.createConversation(HELM_SESSION_ID, {});
    await vi.waitFor(() => expect(sink.events).toContainEqual({ type: "ended", reason: "hands-free started somewhere else" }));
    expect(gateway.getStatus().activeConversations).toBe(1);
    await gateway.shutdown();
  });
});

describe("VoiceGateway WebSocket transport", () => {
  it("upgrades with a valid token and streams binary audio", async () => {
    const { gateway, pushed } = createGateway();
    server = createServer();
    server.on("upgrade", (req, socket, head) => {
      if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const { conversationId, token } = gateway.createConversation(HELM_SESSION_ID, {});

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/api/voice/ws?conversationId=${conversationId}&token=nope`);
    await new Promise<void>((resolve) => rejected.once("error", () => resolve()));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/ws?conversationId=${conversationId}&token=${token}`);
    const messages: any[] = [];
    ws.on("message", (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(String(data)));
    });
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    await vi.waitFor(() => expect(messages[0]).toMatchObject({ type: "hello", transport: "websocket" }));
    ws.send(JSON.stringify({ type: "start", greet: false }));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: "state", state: "listening" }));
    ws.send(Buffer.from(new Int16Array(512).buffer));
    await vi.waitFor(() => expect(pushed).toEqual([512]));
    ws.close();
    await gateway.shutdown();
  });
});
