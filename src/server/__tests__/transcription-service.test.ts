import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const ENV_KEYS = [
  "BRIDGE_TRANSCRIPTION_PROVIDER",
  "BRIDGE_TRANSCRIPTION_TIMEOUT_MS",
  "BRIDGE_TRANSCRIPTION_MAX_DURATION_SECONDS",
  "BRIDGE_WHISPER_CPP_COMMAND",
  "BRIDGE_WHISPER_CPP_MODEL",
  "BRIDGE_WHISPER_CPP_LANGUAGE",
  "BRIDGE_WHISPER_CPP_ARGS_JSON",
  "BRIDGE_WHISPER_CPP_NO_GPU",
] as const;

describe("transcription service", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it("returns disabled status when voice input is unconfigured", async () => {
    const { createTranscriptionService } = await import("../transcription-service.js");

    const service = createTranscriptionService();

    expect(service.getStatus()).toEqual({
      available: false,
      provider: "disabled",
      label: "Unavailable",
      reason: "Voice input is not configured on the server.",
      maxDurationSeconds: 120,
    });
  });

  it("returns disabled status when whisper.cpp is only partially configured", async () => {
    process.env.BRIDGE_TRANSCRIPTION_PROVIDER = "whisper.cpp";
    process.env.BRIDGE_WHISPER_CPP_COMMAND = "whisper-cli";

    const { createTranscriptionService } = await import("../transcription-service.js");

    const service = createTranscriptionService();

    expect(service.getStatus()).toMatchObject({
      available: false,
      provider: "disabled",
      reason: "Set BRIDGE_WHISPER_CPP_COMMAND and BRIDGE_WHISPER_CPP_MODEL to enable voice input.",
    });
  });

  it("spawns whisper.cpp with the expected arguments and returns the transcript", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bridge-transcription-test-"));
    try {
      const modelPath = join(tempDir, "ggml-base.en.bin");
      const audioPath = join(tempDir, "recording.wav");
      writeFileSync(modelPath, "model");
      writeFileSync(audioPath, "audio");

      process.env.BRIDGE_TRANSCRIPTION_PROVIDER = "whisper.cpp";
      process.env.BRIDGE_WHISPER_CPP_COMMAND = "whisper-cli";
      process.env.BRIDGE_WHISPER_CPP_MODEL = modelPath;
      process.env.BRIDGE_WHISPER_CPP_LANGUAGE = "auto";
      process.env.BRIDGE_WHISPER_CPP_ARGS_JSON = JSON.stringify(["--prompt", "bridge"]);
      process.env.BRIDGE_WHISPER_CPP_NO_GPU = "true";

      spawnMock.mockImplementation((command: string, args: string[]) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();

        const outputPrefix = args[args.indexOf("-of") + 1];
        writeFileSync(`${outputPrefix}.txt`, "hello world\n");
        queueMicrotask(() => child.emit("close", 0));

        return child as any;
      });

      const { createTranscriptionService } = await import("../transcription-service.js");
      const service = createTranscriptionService();

      expect(service.getStatus()).toMatchObject({
        available: true,
        provider: "whisper.cpp",
        label: "whisper.cpp",
      });

      const result = await service.transcribe({
        filePath: audioPath,
        workingDir: tempDir,
      });

      expect(result).toEqual({ text: "hello world", provider: "whisper.cpp" });
      expect(spawnMock).toHaveBeenCalledWith(
        "whisper-cli",
        [
          "-m",
          modelPath,
          "-f",
          audioPath,
          "-l",
          "auto",
          "-otxt",
          "-of",
          join(tempDir, "transcript"),
          "-np",
          "-nt",
          "-ng",
          "--prompt",
          "bridge",
        ],
        expect.objectContaining({
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects timed out transcriptions even if the child never closes", async () => {
    vi.useFakeTimers();
    const tempDir = mkdtempSync(join(tmpdir(), "bridge-transcription-test-"));
    try {
      const modelPath = join(tempDir, "ggml-base.en.bin");
      const audioPath = join(tempDir, "recording.wav");
      writeFileSync(modelPath, "model");
      writeFileSync(audioPath, "audio");

      process.env.BRIDGE_TRANSCRIPTION_PROVIDER = "whisper.cpp";
      process.env.BRIDGE_WHISPER_CPP_COMMAND = "whisper-cli";
      process.env.BRIDGE_WHISPER_CPP_MODEL = modelPath;
      process.env.BRIDGE_TRANSCRIPTION_TIMEOUT_MS = "10";

      const kill = vi.fn();
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = kill;
        return child as any;
      });

      const { createTranscriptionService } = await import("../transcription-service.js");
      const service = createTranscriptionService();

      const promise = service.transcribe({
        filePath: audioPath,
        workingDir: tempDir,
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(promise).rejects.toThrow("Transcription timed out after 10ms");
      expect(kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports invalid extra args JSON in status", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bridge-transcription-test-"));
    try {
      const modelPath = join(tempDir, "ggml-base.en.bin");
      writeFileSync(modelPath, "model");

      process.env.BRIDGE_TRANSCRIPTION_PROVIDER = "whisper.cpp";
      process.env.BRIDGE_WHISPER_CPP_COMMAND = "whisper-cli";
      process.env.BRIDGE_WHISPER_CPP_MODEL = modelPath;
      process.env.BRIDGE_WHISPER_CPP_ARGS_JSON = "{bad json}";

      const { createTranscriptionService } = await import("../transcription-service.js");

      const service = createTranscriptionService();

      expect(service.getStatus()).toMatchObject({
        available: false,
        provider: "disabled",
        reason: "BRIDGE_WHISPER_CPP_ARGS_JSON must be valid JSON.",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
