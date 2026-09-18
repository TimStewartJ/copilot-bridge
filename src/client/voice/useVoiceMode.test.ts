import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDomShim } from "../test-dom-shim";
import { createReactDomHarness, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import type { VoiceModeController } from "./useVoiceMode";

const order: string[] = [];

const audio = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn(async () => undefined),
  earcon: vi.fn(),
}));

const voiceApi = vi.hoisted(() => ({
  fetchVoiceStatus: vi.fn(),
  createVoiceConversation: vi.fn(),
  startVoiceInstall: vi.fn(),
}));

const transport = vi.hoisted(() => ({
  sendControl: vi.fn(),
  sendAudio: vi.fn(),
  close: vi.fn(),
}));

vi.mock("./voice-audio", () => ({
  VoiceAudio: class {
    start = audio.start;
    close = audio.close;
    earcon = audio.earcon;
  },
}));
vi.mock("./voice-transport", () => ({ connectVoiceTransport: vi.fn(async () => ({ kind: "websocket", ...transport })) }));
vi.mock("./voice-api", async () => {
  const actual = await vi.importActual<typeof import("./voice-api")>("./voice-api");
  return { ...actual, ...voiceApi };
});

const { useVoiceMode } = await import("./useVoiceMode");

const DEFAULTS = { voice: "af_heart", speed: 1.05, patience: 0.5, bargeIn: true, announce: "watched" as const };
const HELM_SESSION_ID = "11111111-2222-4333-8444-555555555555";

describe("useVoiceMode", () => {
  let harness: ReactDomHarness;
  let controller: VoiceModeController;

  function Probe() {
    controller = useVoiceMode();
    return null;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    order.length = 0;
    voiceApi.fetchVoiceStatus.mockResolvedValue({ install: { installed: true, installing: false }, defaults: DEFAULTS, voices: [] });
    voiceApi.createVoiceConversation.mockImplementation(async () => {
      order.push("conversation");
      return { conversationId: "c1", token: "t1" };
    });
    audio.start.mockImplementation(async () => {
      order.push("audio");
      return { inputSampleRate: 48_000, echoSafe: true };
    });
    harness = await createReactDomHarness({ installDom: () => {
      const dom = installDomShim();
      // The hook schedules reconnects and teardown through window timers.
      Object.assign(window, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
      });
      return dom;
    } });
    await harness.render(createElement(Probe));
  });

  it("explains a missing microphone instead of echoing the browser, and leaves nothing behind", async () => {
    // Firefox's NotFoundError, verbatim.
    audio.start.mockRejectedValueOnce(Object.assign(new Error("The object can not be found here."), { name: "NotFoundError" }));
    await harness.act(() => controller.start(HELM_SESSION_ID));

    expect(controller.error).toBe("No microphone was found. Check your browser and OS audio input settings, then try again.");
    expect(controller).toMatchObject({ phase: "error", active: false, helmSessionId: null });
    // Audio comes first, so a machine without a microphone never creates a voice conversation.
    expect(voiceApi.createVoiceConversation).not.toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalled();
  });

  it("explains a blocked microphone", async () => {
    audio.start.mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    await harness.act(() => controller.start(HELM_SESSION_ID));
    expect(controller.error).toBe("Microphone access was denied. Allow microphone access in your browser settings and try again.");
  });

  it("reports server and connection failures in their own words", async () => {
    voiceApi.createVoiceConversation.mockRejectedValueOnce(Object.assign(new Error("Helm conversation not found. Start or resume one first."), { name: "SecurityError" }));
    await harness.act(() => controller.start(HELM_SESSION_ID));
    expect(controller.error).toBe("Helm conversation not found. Start or resume one first.");
  });

  it("starts audio inside the tap, then resolves the conversation it will speak for", async () => {
    const resolveTarget = vi.fn(async () => {
      order.push("target");
      return HELM_SESSION_ID;
    });
    await harness.act(() => controller.start(resolveTarget));
    await waitUntilAct(harness.act, () => controller.phase === "active");

    expect(order).toEqual(["audio", "target", "conversation"]);
    expect(voiceApi.createVoiceConversation).toHaveBeenCalledWith(HELM_SESSION_ID, DEFAULTS);
    expect(transport.sendControl).toHaveBeenCalledWith({ type: "start", greet: true });
    expect(controller).toMatchObject({ active: true, helmSessionId: HELM_SESSION_ID, error: null });

    await harness.act(() => controller.stop());
    expect(transport.sendControl).toHaveBeenCalledWith({ type: "control", action: "end" });
    expect(controller).toMatchObject({ phase: "ended", active: false, helmSessionId: null });
  });
});
