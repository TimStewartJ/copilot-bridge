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
import { decodePcmBody, encodeAudioFrame, VoiceGateway, type HttpEventSink } from "../voice-gateway.js";
import type { VoiceInstaller } from "../voice-installer.js";
import { createVoiceRouter } from "../voice-router.js";
import type { VoiceBridgeFacade } from "../voice-tools.js";

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

function createGateway(options: { installed?: boolean } = {}) {
  const dataDir = makeTestDir("voice-gateway");
  const paths = resolveVoicePaths({ dataDir, env: {} });
  const { engine, pushed } = createFakeEngine();
  const installer = {
    getStatus: () => ({ installed: options.installed !== false, supported: true, target: "win32-x64", installing: false, assets: [], totalBytes: 0, remainingBytes: 0 }),
    install: vi.fn(async () => undefined),
  } as unknown as VoiceInstaller;
  const listeners = new Set<(event: unknown) => void>();
  const session = {
    sessionId: "v01ce000-0000-4000-8000-000000000001",
    send: vi.fn(async () => "id"),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    on: () => () => undefined,
  };
  const ctx = {
    sessionManager: {
      createVoiceAgentSession: vi.fn(async () => session),
      listModels: vi.fn(async () => [{ id: "gpt-5.6-luna", supportedReasoningEfforts: ["low"] }]),
    },
    settingsStore: { getSettings: () => ({ model: "claude-opus-5" }) },
    globalBus: {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event: unknown) => listeners.forEach((listener) => listener(event)),
    },
    taskStore: { getTask: () => undefined, listTasks: () => [] },
    eventBusRegistry: { getBus: () => undefined },
  } as unknown as AppContext;
  const facade: VoiceBridgeFacade = {
    listSessions: async () => [],
    markRead: () => undefined,
    sendMessage: async () => "started",
    createSession: async () => ({ sessionId: "s" }),
  };
  const gateway = new VoiceGateway({ ctx, facade, runtime: { paths, engine, installer } });
  return { gateway, engine, pushed, installer };
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
    const { conversationId, token } = gateway.createConversation({ voice: "bm_george" });
    const sink = new CollectingSink();
    expect(gateway.attachHttpEvents(conversationId, "wrong-token", sink)).toBeUndefined();
    const detach = gateway.attachHttpEvents(conversationId, token, sink);
    expect(detach).toBeDefined();
    expect(sink.events[0]).toMatchObject({ type: "hello", conversationId, transport: "http", settings: { voice: "bm_george" } });

    expect(gateway.acceptHttpControl(conversationId, token, { type: "start", greet: false })).toBe(true);
    await vi.waitFor(() => expect(sink.events).toContainEqual({ type: "state", state: "listening" }));
    expect(engine.openStream).toHaveBeenCalled();
    expect(sink.events).toContainEqual({ type: "agent", model: "gpt-5.6-luna" });

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
    await request(app).post("/voice/conversations").send({}).expect(409);
    await request(app).post("/voice/conversations/unknown/audio?seq=0").set("content-type", "application/octet-stream").send(Buffer.alloc(4)).expect(404);
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
    const { conversationId, token } = gateway.createConversation({});

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
