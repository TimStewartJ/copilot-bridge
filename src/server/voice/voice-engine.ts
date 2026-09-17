// Bridge-side client for the speech engine child process: lazy start, on-demand model loading,
// request routing, streaming synthesis, idle shutdown and crash recovery.
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  VoiceClipTranscription,
  VoiceEngineCapability,
  VoiceEngineInitOptions,
  VoiceEngineLoadResult,
  VoiceEngineReadyInfo,
  VoiceEngineRequest,
  VoiceEngineResponse,
} from "./voice-engine-protocol.js";
import type { SpeechSynthesisHandle, SpeechSynthesisRequest, VoiceEngineApi } from "./voice-conversation.js";
import type { VoicePaths } from "./voice-catalog.js";
import { currentVoiceTarget } from "./voice-catalog.js";

export type VoiceEngineState = "stopped" | "starting" | "ready" | "failed";

export interface VoiceEngineStatus {
  state: VoiceEngineState;
  detail?: string;
  info?: VoiceEngineReadyInfo;
  /** Model groups currently loaded in the engine process. */
  loaded: VoiceEngineCapability[];
}

type VadListener = (speech: boolean, sampleIndex: number) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  onChunk?: (pcm: Int16Array, sampleRate: number) => void;
}

const REQUEST_TIMEOUTS_MS = {
  init: 60_000,
  load: 180_000,
  open_stream: 10_000,
  predict_turn: 10_000,
  transcribe: 60_000,
  transcribe_file: 600_000,
  synthesize: 120_000,
} as const;

const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000;

const CAPABILITY_LABELS: Record<VoiceEngineCapability, string> = {
  asr: "speech recognition",
  turn: "turn detection",
  tts: "voice",
};

function clampThreads(value: number): number {
  return Math.max(1, Math.min(8, Math.round(value)));
}

export function defaultEngineThreads(logicalCpus = cpus().length): Pick<VoiceEngineInitOptions, "asrThreads" | "ttsThreads" | "turnThreads"> {
  return {
    asrThreads: clampThreads(logicalCpus / 5),
    ttsThreads: clampThreads(logicalCpus / 3),
    turnThreads: clampThreads(logicalCpus / 5),
  };
}

export function describeCapabilities(capabilities: readonly VoiceEngineCapability[]): string {
  const labels = capabilities.map((capability) => CAPABILITY_LABELS[capability]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function resolveEngineWorkerEntry(moduleUrl = import.meta.url): { entry: string; execArgv: string[] } {
  const isSource = moduleUrl.endsWith(".ts");
  const entry = join(dirname(fileURLToPath(moduleUrl)), `voice-engine-worker.${isSource ? "ts" : "js"}`);
  const execArgv = process.execArgv.filter((arg) => !arg.startsWith("--inspect"));
  if (isSource && !execArgv.some((arg) => arg.includes("tsx"))) {
    const tsxLoader = pathToFileURL(createRequire(moduleUrl).resolve("tsx/esm")).href;
    execArgv.push("--import", tsxLoader);
  }
  return { entry, execArgv };
}

export interface VoiceEngineOptions {
  paths: VoicePaths;
  env: NodeJS.ProcessEnv;
  idleShutdownMs?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
  spawn?: (entry: string, execArgv: string[], env: NodeJS.ProcessEnv) => ChildProcess;
}

export class VoiceEngine implements VoiceEngineApi {
  private child?: ChildProcess;
  private startPromise?: Promise<void>;
  private runtimeReady = false;
  private info?: VoiceEngineReadyInfo;
  private readonly loaded = new Set<VoiceEngineCapability>();
  private readonly loading = new Map<VoiceEngineCapability, Promise<void>>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly vadListeners = new Map<string, VadListener>();
  private readonly statusListeners = new Set<(status: VoiceEngineStatus) => void>();
  private requestSeq = 0;
  private statusValue: VoiceEngineStatus = { state: "stopped", loaded: [] };
  private retainCount = 0;
  private idleTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  constructor(private readonly options: VoiceEngineOptions) {
    this.logger = options.logger ?? console;
  }

  get status(): VoiceEngineStatus {
    return this.statusValue;
  }

  onStatus(listener: (status: VoiceEngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Keeps the engine alive while a conversation or transcription is using it. */
  retain(): () => void {
    this.retainCount++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retainCount = Math.max(0, this.retainCount - 1);
      if (this.retainCount === 0 && this.child) {
        this.idleTimer = setTimeout(() => void this.stop("idle"), this.options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS);
        this.idleTimer.unref();
      }
    };
  }

  /** Starts the engine process and its native runtime without loading any models. */
  ensureStarted(): Promise<void> {
    if (this.runtimeReady && this.child) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.shuttingDown = false;
    const run = this.start().finally(() => {
      if (this.startPromise === run) this.startPromise = undefined;
    });
    this.startPromise = run;
    return run;
  }

  /** Starts the engine if needed and loads any missing model groups. */
  async ensureCapabilities(capabilities: readonly VoiceEngineCapability[]): Promise<void> {
    const wanted = [...new Set(capabilities)];
    if (this.runtimeReady && this.child && wanted.every((capability) => this.loaded.has(capability))) return;
    await this.ensureStarted();
    const child = this.child;
    const waits: Promise<void>[] = [];
    const toLoad: VoiceEngineCapability[] = [];
    for (const capability of wanted) {
      if (this.loaded.has(capability)) continue;
      const inFlight = this.loading.get(capability);
      if (inFlight) waits.push(inFlight);
      else toLoad.push(capability);
    }
    if (toLoad.length > 0) {
      this.setStatus({ state: "starting", detail: `Loading ${describeCapabilities(toLoad)}`, info: this.info, loaded: [...this.loaded] });
      const run: Promise<void> = this.request<VoiceEngineLoadResult>({ type: "load", id: 0, capabilities: toLoad }).then((result) => {
        if (this.child !== child) throw new Error("Speech engine stopped while loading models");
        for (const capability of result.loaded) this.loaded.add(capability);
        this.logger.log(`[voice-engine] Loaded ${describeCapabilities(toLoad)} in ${result.loadMs}ms (+${result.warmupMs}ms warmup)`);
      }).finally(() => {
        for (const capability of toLoad) {
          if (this.loading.get(capability) === run) this.loading.delete(capability);
        }
      });
      for (const capability of toLoad) this.loading.set(capability, run);
      waits.push(run);
    }
    try {
      await Promise.all(waits);
    } finally {
      if (this.loading.size === 0 && this.child === child && this.runtimeReady) {
        this.setStatus({ state: "ready", info: this.info, loaded: [...this.loaded] });
      }
    }
  }

  private setStatus(status: VoiceEngineStatus): void {
    this.statusValue = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Status observers must not break engine lifecycle handling.
      }
    }
  }

  private buildChildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.options.env };
    const target = currentVoiceTarget();
    const sherpaPackage = target.startsWith("win32") ? `sherpa-onnx-win-${process.arch}` : `sherpa-onnx-${target}`;
    const nativeDir = join(this.options.paths.engineDir, "node_modules", sherpaPackage);
    if (process.platform === "linux") {
      env.LD_LIBRARY_PATH = [nativeDir, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    } else if (process.platform === "darwin") {
      env.DYLD_LIBRARY_PATH = [nativeDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
    }
    return env;
  }

  private async start(): Promise<void> {
    this.setStatus({ state: "starting", detail: "Starting speech engine", loaded: [] });
    const { entry, execArgv } = resolveEngineWorkerEntry();
    const env = this.buildChildEnv();
    const child = this.options.spawn
      ? this.options.spawn(entry, execArgv, env)
      : fork(entry, [], {
        execArgv,
        env,
        serialization: "advanced",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    this.child = child;
    child.stdout?.on("data", (chunk) => this.logger.log(`[voice-engine] ${String(chunk).trimEnd()}`));
    child.stderr?.on("data", (chunk) => this.logger.warn(`[voice-engine] ${String(chunk).trimEnd()}`));
    child.on("message", (message: VoiceEngineResponse) => this.onMessage(message));
    child.on("exit", (code, signal) => this.onExit(child, code, signal));
    child.on("error", (error) => this.logger.error("[voice-engine] Child process error:", error));

    try {
      const info = await this.request<VoiceEngineReadyInfo>({
        type: "init",
        id: 0,
        options: {
          engineDir: this.options.paths.engineDir,
          modelsDir: this.options.paths.modelsDir,
          audioRetentionSeconds: 90,
          ...defaultEngineThreads(),
        },
      });
      if (this.child !== child) throw new Error("Speech engine stopped while starting");
      this.logger.log(`[voice-engine] Runtime ready in ${info.runtimeMs}ms (${info.scheduling ?? "default scheduling"})`);
      this.info = info;
      this.runtimeReady = true;
      for (const streamId of this.vadListeners.keys()) {
        await this.request({ type: "open_stream", id: 0, streamId });
      }
      this.setStatus({ state: "ready", info, loaded: [...this.loaded] });
      if (this.retainCount === 0) this.retain()();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`[voice-engine] Failed to start: ${detail}`);
      this.runtimeReady = false;
      this.setStatus({ state: "failed", detail, loaded: [] });
      this.killChild(child);
      throw error;
    }
  }

  private onMessage(message: VoiceEngineResponse): void {
    switch (message.type) {
      case "vad":
        this.vadListeners.get(message.streamId)?.(message.speech, message.sampleIndex);
        return;
      case "tts_chunk":
        this.pending.get(message.id)?.onChunk?.(message.pcm, message.sampleRate);
        return;
      case "log":
        this.logger[message.level === "info" ? "log" : message.level](`[voice-engine] ${message.message}`);
        return;
      case "result": {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.ok) request.resolve(message.value);
        else request.reject(new Error(message.error));
        return;
      }
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.runtimeReady = false;
    this.info = undefined;
    this.loaded.clear();
    this.loading.clear();
    const detail = `Speech engine exited (${signal ?? code ?? "unknown"})`;
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error(detail));
      this.pending.delete(id);
    }
    if (this.shuttingDown || this.statusValue.state === "stopped") {
      this.setStatus({ state: "stopped", loaded: [] });
      return;
    }
    this.logger.warn(`[voice-engine] ${detail}`);
    this.setStatus({ state: "failed", detail, loaded: [] });
  }

  private request<T>(
    message: VoiceEngineRequest & { id: number },
    onChunk?: PendingRequest["onChunk"],
    timeoutOverrideMs?: number,
  ): Promise<T> {
    const child = this.child;
    if (!child || !child.connected) return Promise.reject(new Error("Speech engine is not running"));
    const id = ++this.requestSeq;
    const timeoutMs = timeoutOverrideMs ?? REQUEST_TIMEOUTS_MS[message.type as keyof typeof REQUEST_TIMEOUTS_MS] ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Speech engine ${message.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, ...(onChunk ? { onChunk } : {}) });
      child.send({ ...message, id }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private sendFireAndForget(message: VoiceEngineRequest): void {
    const child = this.child;
    if (!child || !child.connected || !this.runtimeReady) return;
    child.send(message, (error) => {
      if (error) this.logger.warn(`[voice-engine] Failed to send ${message.type}: ${error.message}`);
    });
  }

  async openStream(streamId: string, onVad: VadListener): Promise<void> {
    this.vadListeners.set(streamId, onVad);
    await this.ensureStarted();
    await this.request({ type: "open_stream", id: 0, streamId });
  }

  closeStream(streamId: string): void {
    this.vadListeners.delete(streamId);
    this.sendFireAndForget({ type: "close_stream", streamId });
  }

  pushAudio(streamId: string, pcm: Int16Array): void {
    this.sendFireAndForget({ type: "audio", streamId, pcm });
  }

  predictTurn(streamId: string, fromSample: number, toSample: number): Promise<{ probability: number; ms: number }> {
    return this.request({ type: "predict_turn", id: 0, streamId, fromSample, toSample });
  }

  transcribe(streamId: string, fromSample: number, toSample: number): Promise<{ text: string; ms: number }> {
    return this.request({ type: "transcribe", id: 0, streamId, fromSample, toSample });
  }

  /** Transcribes a recorded WAV file, loading speech recognition first if needed. */
  async transcribeFile(filePath: string, options: { timeoutMs?: number } = {}): Promise<VoiceClipTranscription> {
    await this.ensureCapabilities(["asr"]);
    return this.request<VoiceClipTranscription>({ type: "transcribe_file", id: 0, filePath }, undefined, options.timeoutMs);
  }

  synthesize(request: SpeechSynthesisRequest, onChunk: (pcm: Int16Array, sampleRate: number) => void): SpeechSynthesisHandle {
    let requestId: number | undefined;
    let cancelled = false;
    const done = (async () => {
      const promise = this.request<{ firstChunkMs: number; totalMs: number }>(
        { type: "synthesize", id: 0, ...request },
        (pcm, sampleRate) => {
          if (!cancelled) onChunk(pcm, sampleRate);
        },
      );
      requestId = this.requestSeq;
      return promise;
    })();
    return {
      done,
      cancel: () => {
        cancelled = true;
        if (requestId !== undefined) this.sendFireAndForget({ type: "cancel_synthesis", id: requestId });
      },
    };
  }

  private killChild(child: ChildProcess): void {
    if (this.child === child) this.child = undefined;
    try {
      child.kill();
    } catch {
      // Already exited.
    }
  }

  async stop(reason: string): Promise<void> {
    const child = this.child;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (!child) {
      this.setStatus({ state: "stopped", loaded: [] });
      return;
    }
    this.shuttingDown = true;
    this.logger.log(`[voice-engine] Stopping (${reason})`);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.disconnect();
    } catch {
      // Channel already closed.
    }
    const timer = setTimeout(() => this.killChild(child), 3_000);
    await exited;
    clearTimeout(timer);
    if (this.child === child) this.child = undefined;
    this.runtimeReady = false;
    this.loaded.clear();
    this.setStatus({ state: "stopped", loaded: [] });
  }
}
