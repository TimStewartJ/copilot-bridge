import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { concatPcm, decodeBase64Pcm, parseAudioFrame, type VoiceTransportHandlers } from "./voice-transport";
import { buildVoiceWebSocketUrl, voiceConversationPath } from "./voice-api";
import { describeVoiceTool, formatBytes, initialVoiceViewState, reduceVoiceEvent } from "./voice-view-model";

describe("voice transport helpers", () => {
  it("parses binary audio frames", () => {
    const buffer = new ArrayBuffer(12 + 4);
    const view = new DataView(buffer);
    view.setUint8(0, 1);
    view.setUint16(2, 5, true);
    view.setUint32(4, 24000, true);
    view.setUint32(8, 9, true);
    view.setInt16(12, -1234, true);
    view.setInt16(14, 4321, true);
    const frame = parseAudioFrame(buffer)!;
    expect(frame).toMatchObject({ chunkId: 5, sampleRate: 24000, genId: 9 });
    expect(Array.from(frame.pcm)).toEqual([-1234, 4321]);
    expect(parseAudioFrame(new ArrayBuffer(4))).toBeUndefined();
  });

  it("decodes base64 PCM and concatenates upload frames", () => {
    const pcm = new Int16Array([1, -2, 3]);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
    expect(Array.from(decodeBase64Pcm(base64))).toEqual([1, -2, 3]);
    expect(Array.from(concatPcm([new Int16Array([1, 2]), new Int16Array([3])]))).toEqual([1, 2, 3]);
  });

  it("builds websocket and conversation URLs under the app base", () => {
    const url = buildVoiceWebSocketUrl({ conversationId: "abc", token: "t/k" }, { protocol: "https:", host: "bridge.example.devtunnels.ms" });
    expect(url).toBe("wss://bridge.example.devtunnels.ms/api/voice/ws?conversationId=abc&token=t%2Fk");
    expect(voiceConversationPath("a b", "events")).toBe("/api/voice/conversations/a%20b/events");
  });
});

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onclose?: () => void;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe("voice transport connection", () => {
  const ticket = { conversationId: "c1", token: "tok" };
  const hello = { data: JSON.stringify({ type: "hello" }) };
  let handlers: { onEvent: VoiceTransportHandlers["onEvent"]; onAudio: VoiceTransportHandlers["onAudio"]; onClose: ReturnType<typeof vi.fn<(reason: string) => void>> };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeEventSource.instances = [];
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { protocol: "http:", host: "localhost:3333" },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.resetModules();
    handlers = { onEvent: vi.fn(), onAudio: vi.fn(), onClose: vi.fn<(reason: string) => void>() };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to HTTP without treating the failed handshake as a dropped connection", async () => {
    const { connectVoiceTransport } = await import("./voice-transport");
    const pending = connectVoiceTransport(ticket, handlers, "auto");
    const socket = FakeWebSocket.instances[0];
    socket.onerror?.();
    socket.onclose?.();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.instances[0].onmessage?.(hello);
    const transport = await pending;
    expect(transport.kind).toBe("http");
    expect(handlers.onClose).not.toHaveBeenCalled();

    const reconnect = connectVoiceTransport(ticket, handlers, "auto");
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeEventSource.instances[1].onmessage?.(hello);
    await expect(reconnect).resolves.toMatchObject({ kind: "http" });
  });

  it("reports drops of established connections but not client-initiated closes", async () => {
    const { connectVoiceTransport } = await import("./voice-transport");
    const first = connectVoiceTransport(ticket, handlers, "websocket");
    FakeWebSocket.instances[0].onmessage?.(hello);
    await first;
    FakeWebSocket.instances[0].onclose?.();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    const second = connectVoiceTransport(ticket, handlers, "websocket");
    FakeWebSocket.instances[1].onmessage?.(hello);
    (await second).close();
    FakeWebSocket.instances[1].onclose?.();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    const http = connectVoiceTransport(ticket, handlers, "http");
    const source = FakeEventSource.instances[0];
    source.onmessage?.(hello);
    await http;
    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.();
    expect(handlers.onClose).toHaveBeenLastCalledWith("event stream closed");
  });
});

describe("voice view model", () => {
  it("tracks what the dock shows: caption, running tools, notices and counts", () => {
    let state = initialVoiceViewState;
    state = reduceVoiceEvent(state, { type: "hello", transport: "http", state: "listening" });
    state = reduceVoiceEvent(state, { type: "notice", level: "warning", message: "Reconnected." });
    state = reduceVoiceEvent(state, { type: "user", turnId: 1, text: "what's new?" });
    expect(state.caption).toEqual({ speaker: "user", text: "what's new?" });
    expect(state.notice).toBeNull();

    state = reduceVoiceEvent(state, { type: "tool", genId: 1, toolCallId: "t1", name: "bridge_overview", status: "running" });
    state = reduceVoiceEvent(state, { type: "tool", genId: 1, toolCallId: "t2", name: "read_session", status: "running" });
    expect(state.activity.map((entry) => entry.label)).toEqual(["Checking Bridge", "Reading a reply"]);
    state = reduceVoiceEvent(state, { type: "tool", genId: 1, toolCallId: "t1", name: "bridge_overview", status: "done" });
    expect(state.activity.map((entry) => entry.label)).toEqual(["Reading a reply"]);

    // The words themselves live in the Helm chat, not here: deltas change nothing.
    expect(reduceVoiceEvent(state, { type: "assistant_delta", genId: 1, text: "Two sessions " })).toBe(state);
    state = reduceVoiceEvent(state, { type: "assistant_chunk", genId: 1, chunkId: 1, text: "Two sessions finished." });
    state = reduceVoiceEvent(state, { type: "user", turnId: 2, text: "um", handled: "ignored" });
    expect(state.caption).toEqual({ speaker: "assistant", text: "Two sessions finished." });

    state = reduceVoiceEvent(state, { type: "bridge_counts", unread: 2, running: 1, waiting: 0 });
    state = reduceVoiceEvent(state, { type: "state", state: "listening" });
    expect(state).toMatchObject({ transport: "http", voiceState: "listening", activity: [], counts: { unread: 2, running: 1, waiting: 0 } });

    state = reduceVoiceEvent(state, { type: "ended", reason: "user left hands-free" });
    expect(state).toMatchObject({ voiceState: "ended", ended: "user left hands-free" });
  });

  it("formats labels and sizes", () => {
    expect(describeVoiceTool("send_to_session")).toBe("Sending to a session");
    expect(describeVoiceTool("hands_free")).toBe("Adjusting hands-free");
    expect(describeVoiceTool("some_new_tool")).toBe("some new tool");
    expect(formatBytes(891 * 1024 * 1024)).toBe("891 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });
});
