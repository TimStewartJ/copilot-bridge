import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDir } from "../../__tests__/helpers.js";
import { resolveVoicePaths } from "../voice-catalog.js";
import { describeCapabilities, VoiceEngine, type VoiceEngineStatus } from "../voice-engine.js";
import type { VoiceEngineCapability, VoiceEngineRequest } from "../voice-engine-protocol.js";

type SentMessage = VoiceEngineRequest & { id?: number };

class FakeEngineChild extends EventEmitter {
  connected = true;
  readonly sent: SentMessage[] = [];
  private readonly loaded = new Set<VoiceEngineCapability>();
  private readonly held: SentMessage[] = [];
  holdLoads = false;

  send(message: SentMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    if (message.type === "load" && this.holdLoads) {
      this.held.push(message);
    } else {
      queueMicrotask(() => this.reply(message));
    }
    return true;
  }

  releaseLoads(): void {
    this.holdLoads = false;
    for (const message of this.held.splice(0)) this.reply(message);
  }

  private reply(message: SentMessage): void {
    let value: unknown;
    switch (message.type) {
      case "init":
        value = { runtimeMs: 5, scheduling: "test" };
        break;
      case "load":
        for (const capability of message.capabilities) this.loaded.add(capability);
        value = { loaded: [...this.loaded], loadMs: 10, warmupMs: 2 };
        break;
      case "transcribe_file":
        value = { text: "hello from a clip", audioSeconds: 3, speechSeconds: 2, chunks: 1, ms: 30 };
        break;
      default:
        value = true;
    }
    this.emit("message", { type: "result", id: message.id, ok: true, value });
  }

  crash(): void {
    this.connected = false;
    this.emit("exit", 1, null);
  }

  disconnect(): void {
    this.connected = false;
    queueMicrotask(() => this.emit("exit", 0, null));
  }

  kill(): boolean {
    this.disconnect();
    return true;
  }
}

const quietLogger = { log() {}, warn() {}, error() {} };
let engines: VoiceEngine[] = [];

function createEngine() {
  const children: FakeEngineChild[] = [];
  const statuses: VoiceEngineStatus[] = [];
  const engine = new VoiceEngine({
    paths: resolveVoicePaths({ dataDir: makeTestDir("voice-engine"), env: {} }),
    env: {},
    logger: quietLogger,
    spawn: () => {
      const child = new FakeEngineChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  engine.onStatus((status) => statuses.push(status));
  engines.push(engine);
  return { engine, children, statuses };
}

afterEach(async () => {
  await Promise.all(engines.map((engine) => engine.stop("test cleanup")));
  engines = [];
});

describe("VoiceEngine on-demand models", () => {
  it("describes model groups for status text", () => {
    expect(describeCapabilities(["asr"])).toBe("speech recognition");
    expect(describeCapabilities(["asr", "turn", "tts"])).toBe("speech recognition, turn detection and voice");
  });

  it("starts the runtime and loads only speech recognition for clip transcription", async () => {
    const { engine, children, statuses } = createEngine();

    const result = await engine.transcribeFile("clip.wav", { timeoutMs: 1_000 });

    expect(result.text).toBe("hello from a clip");
    expect(children).toHaveLength(1);
    expect(children[0]!.sent.map((message) => message.type)).toEqual(["init", "load", "transcribe_file"]);
    expect(children[0]!.sent[1]).toMatchObject({ type: "load", capabilities: ["asr"] });
    expect(children[0]!.sent[2]).toMatchObject({ type: "transcribe_file", filePath: "clip.wav" });
    expect(engine.status).toMatchObject({ state: "ready", loaded: ["asr"] });
    expect(statuses.map((status) => status.detail).filter(Boolean)).toContain("Loading speech recognition");
  });

  it("joins in-flight loads instead of loading a model group twice", async () => {
    const { engine, children } = createEngine();
    await engine.ensureStarted();
    const child = children[0]!;
    child.holdLoads = true;

    const dictation = engine.ensureCapabilities(["asr"]);
    const voiceMode = engine.ensureCapabilities(["asr", "turn", "tts"]);
    await Promise.resolve();
    expect(engine.status.state).toBe("starting");
    child.releaseLoads();
    await Promise.all([dictation, voiceMode]);

    const loads = child.sent.filter((message) => message.type === "load");
    expect(loads.map((message) => (message as { capabilities: VoiceEngineCapability[] }).capabilities)).toEqual([["asr"], ["turn", "tts"]]);
    expect(engine.status).toMatchObject({ state: "ready", loaded: ["asr", "turn", "tts"] });

    await engine.ensureCapabilities(["tts", "asr"]);
    expect(child.sent.filter((message) => message.type === "load")).toHaveLength(2);
  });

  it("forgets loaded models when the engine process dies and reloads on next use", async () => {
    const { engine, children } = createEngine();
    await engine.ensureCapabilities(["asr", "turn"]);
    children[0]!.crash();

    expect(engine.status).toMatchObject({ state: "failed", loaded: [] });

    await engine.ensureCapabilities(["asr"]);
    expect(children).toHaveLength(2);
    expect(children[1]!.sent.map((message) => message.type)).toEqual(["init", "load"]);
    expect(engine.status).toMatchObject({ state: "ready", loaded: ["asr"] });
  });
});
