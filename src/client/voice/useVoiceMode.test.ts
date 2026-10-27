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
const preferences = vi.hoisted(() => ({
  data: { schemaVersion: 1, settings: { model: "", typedReasoningEffort: "max", spokenReasoningEffort: "medium", glossary: "", voice: "af_heart", speed: 1.05, patience: 0.5, bargeIn: true, announce: "watched", echoSafe: true, transport: "auto" } },
  patch: vi.fn(),
}));
vi.mock("../helm/helm-settings", () => ({
  useHelmPreferences: () => ({ data: preferences.data, error: null }),
  refreshHelmSettings: async () => preferences.data,
  patchHelmSettings: preferences.patch,
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
type Handlers = { onEvent(event: Record<string, unknown>): void; onClose(reason?: string): void };
const connections = vi.hoisted(() => ({
  list: [] as Array<{ handlers: Handlers; close: ReturnType<typeof vi.fn> }>,
  /** When set, the next connection waits for this before it is ready. */
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("./voice-transport", () => ({
  connectVoiceTransport: vi.fn(async (_ticket: unknown, handlers: Handlers) => {
    const close = vi.fn();
    const gate = connections.gate;
    connections.gate = undefined;
    if (gate) await gate;
    connections.list.push({ handlers, close });
    return { kind: "websocket", ...transport, close };
  }),
}));
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

    expect(controller.error).toBe("No microphone found. Check your browser and system audio input.");
    expect(controller).toMatchObject({ phase: "error", active: false, sessionId: null });
    // Audio comes first, so a machine without a microphone never creates a voice conversation.
    expect(voiceApi.createVoiceConversation).not.toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalled();
  });

  it("explains a blocked microphone", async () => {
    audio.start.mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    await harness.act(() => controller.start(HELM_SESSION_ID));
    expect(controller.error).toBe("Microphone access was denied. Allow it in browser settings, then retry.");
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
    expect(voiceApi.createVoiceConversation).toHaveBeenCalledWith(HELM_SESSION_ID, expect.objectContaining(DEFAULTS));
    expect(transport.sendControl).toHaveBeenCalledWith({ type: "start", greet: true });
    expect(controller).toMatchObject({ active: true, sessionId: HELM_SESSION_ID, error: null });
    expect(controller.echoSafe).toBe(true);
    expect(controller.transportPreference).toBe("auto");

    await harness.act(() => controller.stop());
    expect(transport.sendControl).toHaveBeenCalledWith({ type: "control", action: "end" });
    expect(controller).toMatchObject({ phase: "ended", active: false, sessionId: null });
  });

  it("moves to another chat without the last one's cleanup closing it", async () => {
    const list = connections.list;
    list.length = 0;
    await harness.act(() => controller.start(HELM_SESSION_ID));
    await waitUntilAct(harness.act, () => controller.phase === "active");
    // The server ends the first conversation (it was replaced), and hands-free starts in another chat at once.
    await harness.act(() => list[0]!.handlers.onEvent({ type: "ended", reason: "hands-free started somewhere else" }));
    await harness.act(() => controller.start("22222222-3333-4444-8555-666666666666"));
    await waitUntilAct(harness.act, () => controller.phase === "active");
    await harness.act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(list).toHaveLength(2);
    expect(list[1]!.close).not.toHaveBeenCalled();
    expect(controller).toMatchObject({ active: true, sessionId: "22222222-3333-4444-8555-666666666666" });
  });

  it("closes a reconnect for the last chat that finishes after hands-free moved on", async () => {
    const list = connections.list;
    list.length = 0;
    await harness.act(() => controller.start(HELM_SESSION_ID));
    await waitUntilAct(harness.act, () => controller.phase === "active");
    let open!: () => void;
    connections.gate = new Promise((resolve) => { open = resolve; });
    // The connection drops; the reconnect is still on its way when hands-free starts in another chat.
    await harness.act(() => list[0]!.handlers.onClose("network"));
    await harness.act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    await harness.act(() => controller.start("22222222-3333-4444-8555-666666666666"));
    await waitUntilAct(harness.act, () => controller.phase === "active");
    await harness.act(async () => { open(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(list).toHaveLength(3);
    // The late reconnect (pushed last) is closed; the new chat's connection is left alone.
    expect(list[2]!.close).toHaveBeenCalled();
    expect(list[1]!.close).not.toHaveBeenCalled();
    expect(controller).toMatchObject({ phase: "active", sessionId: "22222222-3333-4444-8555-666666666666" });
  });

  it("persists voice and playback settings on the server, applying live config only after success", async () => {
    preferences.patch.mockResolvedValueOnce({ ...preferences.data, settings: { ...preferences.data.settings, voice: "bm_george", patience: 0.9 } });
    await harness.act(() => controller.updateSettings({ voice: "bm_george", patience: 0.9 }));
    expect(preferences.patch).toHaveBeenCalledWith({ voice: "bm_george", patience: 0.9 });
    expect(controller.settings).toMatchObject({ voice: "bm_george", patience: 0.9 });
    preferences.patch.mockRejectedValueOnce(new Error("Settings disk unavailable"));
    await harness.act(() => controller.setEchoSafe(false));
    expect(controller.echoSafe).toBe(true);
    expect(controller.error).toBe("Settings disk unavailable");
    expect(preferences.patch).toHaveBeenLastCalledWith({ echoSafe: false });
  });
});
