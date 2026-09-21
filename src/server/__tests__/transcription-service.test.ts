import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionService,
  describeTranscriptionUnavailable,
  type TranscriptionSpeechEngine,
} from "../transcription-service.js";
import type { VoiceInstallStatus } from "../voice/voice-installer.js";

function installStatus(overrides: Partial<VoiceInstallStatus> = {}): VoiceInstallStatus {
  return {
    supported: true,
    target: "linux-x64",
    installed: true,
    installing: false,
    totalBytes: 100,
    remainingBytes: 0,
    assets: [],
    ...overrides,
  };
}

function createEngine(result: Partial<Awaited<ReturnType<TranscriptionSpeechEngine["transcribeFile"]>>> = {}) {
  const release = vi.fn();
  const engine = {
    retain: vi.fn(() => release),
    transcribeFile: vi.fn(async () => ({ text: " Hello bridge ", audioSeconds: 2, speechSeconds: 1.5, chunks: 1, ms: 40, format: "opus" as const, bytes: 8_192, ...result })),
  };
  return { engine, release };
}

describe("transcription service", () => {
  it("describes why the chat mic is unavailable until the speech engine is installed", () => {
    expect(describeTranscriptionUnavailable(installStatus())).toBeUndefined();
    expect(describeTranscriptionUnavailable(installStatus({ supported: false, installed: false, target: "win32-arm64" })))
      .toBe("Local speech recognition isn't supported on win32-arm64.");
    expect(describeTranscriptionUnavailable(installStatus({
      installed: false,
      installing: true,
      progress: { assetId: "parakeet-v3", label: "Parakeet", phase: "downloading", receivedBytes: 1, totalBytes: 2, overallFraction: 0.42 },
    }))).toBe("The speech engine is still installing (42%).");
    expect(describeTranscriptionUnavailable(installStatus({ installed: false }))).toContain("Settings → Voice");
    expect(describeTranscriptionUnavailable(installStatus({ installed: false, error: "Digest mismatch." })))
      .toMatch(/^Speech engine setup failed: Digest mismatch\. Set up/);
  });

  it("reports status from the installer on every call", () => {
    let status = installStatus({ installed: false });
    const { engine } = createEngine();
    const service = createTranscriptionService({ installer: { getStatus: () => status }, engine, env: {} });

    expect(service.getStatus()).toMatchObject({ available: false, provider: "disabled", maxDurationSeconds: 300 });
    status = installStatus();
    expect(service.getStatus()).toEqual({
      available: true,
      provider: "speech-engine",
      label: "Parakeet v3 (local)",
      maxDurationSeconds: 300,
      opusUploads: true,
    });
  });

  it("stops advertising compressed uploads when they are switched off", () => {
    const { engine } = createEngine();
    const service = createTranscriptionService({
      installer: { getStatus: () => installStatus() },
      engine,
      env: { BRIDGE_TRANSCRIPTION_OPUS_UPLOADS: "false" },
    });
    expect(service.getStatus().opusUploads).toBe(false);
  });

  it("disables compression and reports an invalid switch value", () => {
    const { engine } = createEngine();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const service = createTranscriptionService({ installer: { getStatus: () => installStatus() }, engine,
        env: { BRIDGE_TRANSCRIPTION_OPUS_UPLOADS: "flase" } });
      expect(service.getStatus().opusUploads).toBe(false);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it("logs how each recording arrived, so a browser that stopped compressing shows up", async () => {
    const { engine } = createEngine();
    const logger = { log: vi.fn() };
    const service = createTranscriptionService({ installer: { getStatus: () => installStatus() }, engine, env: {}, logger });

    await service.transcribe({ filePath: "clip.ogg" });
    expect(logger.log).toHaveBeenCalledWith("[transcription] 2s clip (opus, 8 KB; 1.5s speech, 1 chunk) in 40ms");
  });

  it("honors the configured maximum recording length", () => {
    const { engine } = createEngine();
    const service = createTranscriptionService({
      installer: { getStatus: () => installStatus() },
      engine,
      env: { BRIDGE_TRANSCRIPTION_MAX_DURATION_SECONDS: "600" },
    });
    expect(service.getStatus().maxDurationSeconds).toBe(600);
  });

  it("keeps the engine alive while transcribing and trims the transcript", async () => {
    const { engine, release } = createEngine();
    const service = createTranscriptionService({ installer: { getStatus: () => installStatus() }, engine, env: {} });

    await expect(service.transcribe({ filePath: "clip.wav" })).resolves.toEqual({ text: "Hello bridge", provider: "speech-engine" });
    expect(engine.retain).toHaveBeenCalledOnce();
    expect(engine.transcribeFile).toHaveBeenCalledWith("clip.wav", { timeoutMs: 1_500_000 });
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails clearly when the recording has no speech and still releases the engine", async () => {
    const { engine, release } = createEngine({ text: "  " });
    const service = createTranscriptionService({ installer: { getStatus: () => installStatus() }, engine, env: {} });

    await expect(service.transcribe({ filePath: "quiet.wav" })).rejects.toThrow("No speech was detected");
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports in-flight transcription until it settles, including a failure", async () => {
    const { engine } = createEngine();
    let reject!: (error: Error) => void;
    engine.transcribeFile.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const service = createTranscriptionService({ installer: { getStatus: () => installStatus() }, engine, env: {} });
    expect(service.getActiveCount?.()).toBe(0);
    const transcription = service.transcribe({ filePath: "clip.wav" });
    expect(service.getActiveCount?.()).toBe(1);
    reject(new Error("failed"));
    await expect(transcription).rejects.toThrow("failed");
    expect(service.getActiveCount?.()).toBe(0);
  });

  it("releases the engine when transcription fails", async () => {
    const { engine, release } = createEngine();
    engine.transcribeFile.mockRejectedValueOnce(new Error("Speech engine exited (1)"));
    const service = createTranscriptionService({ installer: { getStatus: () => installStatus() }, engine, env: {} });

    await expect(service.transcribe({ filePath: "clip.wav" })).rejects.toThrow("Speech engine exited");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not start the engine when the speech engine is not installed", async () => {
    const { engine } = createEngine();
    const service = createTranscriptionService({ installer: { getStatus: () => installStatus({ installed: false }) }, engine, env: {} });

    await expect(service.transcribe({ filePath: "clip.wav" })).rejects.toThrow("Settings → Voice");
    expect(engine.retain).not.toHaveBeenCalled();
    expect(engine.transcribeFile).not.toHaveBeenCalled();
  });
});
