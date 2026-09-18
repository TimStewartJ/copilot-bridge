import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";
import type { VoiceInstallStatus, VoiceStatus } from "../../voice/voice-api";
import { describeEngineState, describeInstallBadge, SpeechEngineSection } from "./SpeechEngineSection";

const apiMocks = vi.hoisted(() => ({
  fetchTranscriptionStatus: vi.fn(),
}));

const voiceApiMocks = vi.hoisted(() => ({
  fetchVoiceStatus: vi.fn(),
  startVoiceInstall: vi.fn(),
}));

vi.mock("../../api", () => apiMocks);
vi.mock("../../voice/voice-api", () => voiceApiMocks);

const TOTAL_BYTES = 965_580_001;

function install(overrides: Partial<VoiceInstallStatus> = {}): VoiceInstallStatus {
  return {
    supported: true,
    target: "win32-x64",
    installed: false,
    installing: false,
    totalBytes: TOTAL_BYTES,
    remainingBytes: TOTAL_BYTES,
    assets: [
      { id: "sherpa-onnx-win-x64", label: "sherpa-onnx-win-x64 1.13.8", kind: "npm", sizeBytes: 9_000_000, installed: false },
      { id: "parakeet-v3", label: "Parakeet TDT 0.6B v3 speech recognition", kind: "model", sizeBytes: 487_000_000, installed: false },
    ],
    ...overrides,
  };
}

function voiceStatus(installOverrides: Partial<VoiceInstallStatus> = {}, engine: VoiceStatus["engine"] = { state: "stopped", loaded: [] }): VoiceStatus {
  return {
    install: install(installOverrides),
    engine,
    voices: [],
    defaults: { voice: "af_heart", speed: 1, patience: 0.5, bargeIn: true, announce: "watched" },
    activeConversations: 0,
  };
}

const unavailableMic = {
  available: false,
  provider: "disabled",
  label: "Unavailable",
  reason: "Set up the speech engine in Settings → Voice, or from Helm's hands-free mode.",
  maxDurationSeconds: 120,
};

const availableMic = { available: true, provider: "speech-engine", label: "Parakeet v3 (local)", maxDurationSeconds: 120 };

function text(harness: ReactDomHarness): string {
  return harness.dom.container.textContent ?? "";
}

async function renderSection() {
  const harness = await createReactDomHarness();
  await harness.render(createElement(MemoryRouter, null, createElement(SpeechEngineSection)));
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers();
  apiMocks.fetchTranscriptionStatus.mockReset();
  voiceApiMocks.fetchVoiceStatus.mockReset();
  voiceApiMocks.startVoiceInstall.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SpeechEngineSection", () => {
  it("installs the speech engine and follows progress until the chat mic is ready", async () => {
    voiceApiMocks.fetchVoiceStatus.mockResolvedValue(voiceStatus());
    apiMocks.fetchTranscriptionStatus.mockResolvedValue(unavailableMic);
    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => text(harness).includes("Not installed"));
      expect(text(harness)).toContain("Set up the speech engine in Settings → Voice");
      expect(text(harness)).toContain("Parakeet TDT 0.6B v3 speech recognition");

      const installButton = findAllByTag(harness.dom.container, "BUTTON").find((button) => button.textContent?.includes("Download and set up"));
      expect(installButton?.textContent).toContain("Download and set up (921 MB)");

      voiceApiMocks.startVoiceInstall.mockResolvedValue(install({ installing: true }));
      voiceApiMocks.fetchVoiceStatus.mockResolvedValue(voiceStatus({
        installing: true,
        progress: { assetId: "parakeet-v3", label: "Parakeet TDT 0.6B v3 speech recognition", phase: "downloading", receivedBytes: 1, totalBytes: 2, overallFraction: 0.42 },
      }));
      await harness.act(async () => {
        await getReactProps(installButton)?.onClick?.();
      });
      expect(voiceApiMocks.startVoiceInstall).toHaveBeenCalledOnce();
      await waitUntilAct(harness.act, () => text(harness).includes("Installing 42%"));
      expect(text(harness)).toContain("Downloading Parakeet TDT 0.6B v3 speech recognition");

      voiceApiMocks.fetchVoiceStatus.mockResolvedValue(voiceStatus({
        installed: true,
        remainingBytes: 0,
        assets: install().assets!.map((asset) => ({ ...asset, installed: true })),
      }));
      apiMocks.fetchTranscriptionStatus.mockResolvedValue(availableMic);
      await advanceTimersByTimeAct(harness.act, 1_000);
      await waitUntilAct(harness.act, () => text(harness).includes("Installed"));
      expect(text(harness)).toContain("Ready. Recordings up to 120 seconds are transcribed on this computer.");
      expect(findAllByTag(harness.dom.container, "A").map((link) => link.textContent)).toContain("Open Helm");
      expect(findAllByTag(harness.dom.container, "BUTTON").some((button) => button.textContent?.includes("Download and set up"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("explains unsupported hosts without offering an install", async () => {
    voiceApiMocks.fetchVoiceStatus.mockResolvedValue(voiceStatus({ supported: false, target: "win32-arm64" }));
    apiMocks.fetchTranscriptionStatus.mockResolvedValue({ ...unavailableMic, reason: "Local speech recognition isn't supported on win32-arm64." });
    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => text(harness).includes("Unsupported"));
      expect(text(harness)).toContain("isn't available for this host (win32-arm64)");
      expect(findAllByTag(harness.dom.container, "BUTTON").some((button) => button.textContent?.includes("Download and set up"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("offers a retry after a failed setup", async () => {
    voiceApiMocks.fetchVoiceStatus.mockResolvedValue(voiceStatus({ error: "Digest mismatch for parakeet-v3." }));
    apiMocks.fetchTranscriptionStatus.mockResolvedValue(unavailableMic);
    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => text(harness).includes("Setup failed"));
      expect(text(harness)).toContain("Digest mismatch for parakeet-v3.");
      expect(findAllByTag(harness.dom.container, "BUTTON").some((button) => button.textContent?.includes("Retry setup"))).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("speech engine status copy", () => {
  it("describes the engine lifecycle", () => {
    expect(describeEngineState({ state: "stopped" })).toContain("starts when you use the chat mic or Helm's hands-free mode");
    expect(describeEngineState({ state: "starting", detail: "Loading speech recognition" })).toBe("Loading speech recognition…");
    expect(describeEngineState({ state: "ready", loaded: ["asr"] })).toBe("Running with speech recognition loaded.");
    expect(describeEngineState({ state: "ready", loaded: ["asr", "turn", "tts"] })).toBe("Running with speech recognition, turn detection and voice loaded.");
    expect(describeEngineState({ state: "failed", detail: "Speech engine exited (1)" })).toContain("(Speech engine exited (1))");
  });

  it("labels install states", () => {
    expect(describeInstallBadge(install({ installed: true })).text).toBe("Installed");
    expect(describeInstallBadge(install({ installing: true })).text).toBe("Installing 0%");
    expect(describeInstallBadge(install({ error: "boom" })).text).toBe("Setup failed");
    expect(describeInstallBadge(install()).text).toBe("Not installed");
    expect(describeInstallBadge(install({ supported: false })).text).toBe("Unsupported");
  });
});
