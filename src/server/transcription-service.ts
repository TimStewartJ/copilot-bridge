import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TranscriptionStatus {
  available: boolean;
  provider: "disabled" | "whisper.cpp";
  label: string;
  reason?: string;
  maxDurationSeconds: number;
}

export interface TranscriptionResult {
  text: string;
  provider: Exclude<TranscriptionStatus["provider"], "disabled">;
}

export interface TranscriptionRequest {
  filePath: string;
  workingDir: string;
}

export interface TranscriptionService {
  getStatus(): TranscriptionStatus;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

const DEFAULT_MAX_DURATION_SECONDS = 120;
const DEFAULT_TIMEOUT_MS = 120_000;

export function createTranscriptionService(env: NodeJS.ProcessEnv = process.env): TranscriptionService {
  const maxDurationSeconds = parsePositiveInt(env.BRIDGE_TRANSCRIPTION_MAX_DURATION_SECONDS, DEFAULT_MAX_DURATION_SECONDS);
  const provider = resolveProvider(env, maxDurationSeconds);

  if (provider.kind === "disabled") {
    return createDisabledService(maxDurationSeconds, provider.reason);
  }

  return createWhisperCppService({
    command: provider.command,
    modelPath: provider.modelPath,
    language: provider.language,
    extraArgs: provider.extraArgs,
    noGpu: provider.noGpu,
    timeoutMs: provider.timeoutMs,
    maxDurationSeconds,
  });
}

function createDisabledService(maxDurationSeconds: number, reason: string): TranscriptionService {
  return {
    getStatus() {
      return {
        available: false,
        provider: "disabled",
        label: "Unavailable",
        reason,
        maxDurationSeconds,
      };
    },
    async transcribe() {
      throw new Error(reason);
    },
  };
}

interface WhisperCppConfig {
  command: string;
  modelPath: string;
  language: string;
  extraArgs: string[];
  noGpu: boolean;
  timeoutMs: number;
  maxDurationSeconds: number;
}

function createWhisperCppService(config: WhisperCppConfig): TranscriptionService {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    getStatus() {
      return {
        available: true,
        provider: "whisper.cpp",
        label: "whisper.cpp",
        maxDurationSeconds: config.maxDurationSeconds,
      };
    },
    transcribe(request) {
      let completion: Promise<void> = Promise.resolve();
      const run = async () => {
        const outputPrefix = join(request.workingDir, "transcript");
        const outputPath = `${outputPrefix}.txt`;
        const execution = runCommand(config.command, buildWhisperCppArgs(config, request.filePath, outputPrefix), config.timeoutMs);
        completion = execution.completion;
        const stderr = await execution.result;
        const text = (await readFile(outputPath, "utf-8").catch(() => "")).trim();
        if (!text) {
          const detail = stderr.trim();
          throw new Error(detail ? `No transcript returned (${detail})` : "No transcript returned");
        }
        return { text, provider: "whisper.cpp" as const };
      };

      const job = tail.then(run, run);
      tail = job.then(
        () => completion,
        () => completion.then(() => undefined, () => undefined),
      );
      return job;
    },
  };
}

type ResolvedProvider =
  | { kind: "disabled"; reason: string }
  | {
      kind: "whisper.cpp";
      command: string;
      modelPath: string;
      language: string;
      extraArgs: string[];
      noGpu: boolean;
      timeoutMs: number;
    };

function resolveProvider(env: NodeJS.ProcessEnv, maxDurationSeconds: number): ResolvedProvider {
  const provider = env.BRIDGE_TRANSCRIPTION_PROVIDER?.trim();
  const whisperCommand = env.BRIDGE_WHISPER_CPP_COMMAND?.trim() ?? "";
  const whisperModel = env.BRIDGE_WHISPER_CPP_MODEL?.trim() ?? "";

  if (provider && provider !== "whisper.cpp" && provider !== "disabled") {
    return {
      kind: "disabled",
      reason: `Unsupported transcription provider: ${provider}`,
    };
  }

  const shouldUseWhisperCpp = provider === "whisper.cpp" || (!provider && (whisperCommand || whisperModel));
  if (!shouldUseWhisperCpp) {
    return {
      kind: "disabled",
      reason: "Voice input is not configured on the server.",
    };
  }

  if (!whisperCommand || !whisperModel) {
    return {
      kind: "disabled",
      reason: "Set BRIDGE_WHISPER_CPP_COMMAND and BRIDGE_WHISPER_CPP_MODEL to enable voice input.",
    };
  }
  if (!existsSync(whisperModel)) {
    return {
      kind: "disabled",
      reason: "The configured whisper.cpp model file does not exist.",
    };
  }
  if (looksLikePath(whisperCommand) && !existsSync(whisperCommand)) {
    return {
      kind: "disabled",
      reason: "The configured whisper.cpp command does not exist.",
    };
  }

  const extraArgs = parseArgsJson(env.BRIDGE_WHISPER_CPP_ARGS_JSON);
  if (!extraArgs.ok) {
    return {
      kind: "disabled",
      reason: extraArgs.reason,
    };
  }

  return {
    kind: "whisper.cpp",
    command: whisperCommand,
    modelPath: whisperModel,
    language: env.BRIDGE_WHISPER_CPP_LANGUAGE?.trim() || "auto",
    extraArgs: extraArgs.value,
    noGpu: parseBoolean(env.BRIDGE_WHISPER_CPP_NO_GPU),
    timeoutMs: parsePositiveInt(env.BRIDGE_TRANSCRIPTION_TIMEOUT_MS, Math.max(DEFAULT_TIMEOUT_MS, maxDurationSeconds * 5_000)),
  };
}

function buildWhisperCppArgs(config: WhisperCppConfig, filePath: string, outputPrefix: string): string[] {
  const args = [
    "-m",
    config.modelPath,
    "-f",
    filePath,
    "-l",
    config.language,
    "-otxt",
    "-of",
    outputPrefix,
    "-np",
    "-nt",
  ];
  if (config.noGpu) args.push("-ng");
  if (config.extraArgs.length > 0) args.push(...config.extraArgs);
  return args;
}

function runCommand(command: string, args: string[], timeoutMs: number): {
  result: Promise<string>;
  completion: Promise<void>;
} {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let resultSettled = false;
  let completionSettled = false;
  let resolveResult!: (value: string) => void;
  let rejectResult!: (error: Error) => void;
  let resolveCompletion!: () => void;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    rejectResultOnce(new Error(`Transcription timed out after ${timeoutMs}ms`));
    child.kill();
    forceKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
  }, timeoutMs);

  const rejectResultOnce = (error: Error) => {
    if (resultSettled) return;
    resultSettled = true;
    clearTimeout(timer);
    rejectResult(error);
  };

  const resolveResultOnce = (value: string) => {
    if (resultSettled) return;
    resultSettled = true;
    clearTimeout(timer);
    resolveResult(value);
  };

  const resolveCompletionOnce = () => {
    if (completionSettled) return;
    completionSettled = true;
    clearTimeout(forceKillTimer);
    resolveCompletion();
  };

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    rejectResultOnce(error);
    resolveCompletionOnce();
  });
  child.on("close", (code) => {
    if (!timedOut) {
      if (code === 0) {
        resolveResultOnce(stderr || stdout);
      } else {
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        rejectResultOnce(new Error(detail ? `Transcription failed with exit code ${code}: ${detail}` : `Transcription failed with exit code ${code}`));
      }
    }
    resolveCompletionOnce();
  });

  return { result, completion };
}

function parseArgsJson(raw: string | undefined): { ok: true; value: string[] } | { ok: false; reason: string } {
  if (!raw?.trim()) return { ok: true, value: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return { ok: true, value: parsed };
    }
    return { ok: false, reason: "BRIDGE_WHISPER_CPP_ARGS_JSON must be a JSON array of strings." };
  } catch {
    return { ok: false, reason: "BRIDGE_WHISPER_CPP_ARGS_JSON must be valid JSON." };
  }
}

function parseBoolean(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(raw ?? "");
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}
