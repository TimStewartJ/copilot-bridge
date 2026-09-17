import {
  buildVoiceWebSocketUrl,
  voiceConversationPath,
  type VoiceConversationTicket,
  type VoiceTransportPreference,
} from "./voice-api";

export interface VoiceAudioMessage {
  genId: number;
  chunkId: number;
  sampleRate: number;
  pcm: Int16Array;
}

export interface VoiceTransportHandlers {
  onEvent(event: Record<string, any>): void;
  onAudio(audio: VoiceAudioMessage): void;
  onClose(reason: string): void;
}

export interface VoiceTransport {
  readonly kind: "websocket" | "http";
  sendControl(message: Record<string, unknown>): void;
  sendAudio(pcm: Int16Array): void;
  close(): void;
}

const WS_HELLO_TIMEOUT_MS = 4_000;
const HTTP_HELLO_TIMEOUT_MS = 12_000;
const HTTP_AUDIO_FLUSH_MS = 90;
const HTTP_MAX_INFLIGHT = 3;

export function parseAudioFrame(buffer: ArrayBuffer): VoiceAudioMessage | undefined {
  if (buffer.byteLength < 12) return undefined;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 1) return undefined;
  const length = Math.floor((buffer.byteLength - 12) / 2);
  return {
    chunkId: view.getUint16(2, true),
    sampleRate: view.getUint32(4, true),
    genId: view.getUint32(8, true),
    pcm: new Int16Array(buffer.slice(12, 12 + length * 2)),
  };
}

export function decodeBase64Pcm(data: string): Int16Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length - (binary.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** Concatenates queued PCM frames for one HTTP upload. */
export function concatPcm(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const output = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}

function connectWebSocket(ticket: VoiceConversationTicket, handlers: VoiceTransportHandlers): Promise<VoiceTransport> {
  return new Promise((resolve, reject) => {
    let opened = false;
    let failed = false;
    let closedByClient = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(buildVoiceWebSocketUrl(ticket));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    socket.binaryType = "arraybuffer";
    const fail = (message: string) => {
      if (opened || failed) return;
      failed = true;
      window.clearTimeout(timer);
      reject(new Error(message));
    };
    const transport: VoiceTransport = {
      kind: "websocket",
      sendControl: (message) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      sendAudio: (pcm) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(new Int16Array(pcm));
      },
      close: () => {
        closedByClient = true;
        socket.close(1000, "client closed");
      },
    };
    const timer = window.setTimeout(() => {
      fail("WebSocket connection timed out");
      socket.close();
    }, WS_HELLO_TIMEOUT_MS);
    socket.onmessage = (event) => {
      if (failed) return;
      if (typeof event.data === "string") {
        let message: Record<string, any>;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!opened && message.type === "hello") {
          opened = true;
          window.clearTimeout(timer);
          resolve(transport);
        }
        handlers.onEvent(message);
        return;
      }
      const audio = parseAudioFrame(event.data as ArrayBuffer);
      if (audio) handlers.onAudio(audio);
    };
    socket.onerror = () => fail("WebSocket connection failed");
    socket.onclose = () => {
      window.clearTimeout(timer);
      if (!opened) {
        fail("WebSocket closed before it was ready");
        return;
      }
      // Only a socket that actually carried the conversation reports a close; failed handshakes just reject.
      if (!closedByClient) handlers.onClose("websocket closed");
    };
  });
}

function connectHttp(ticket: VoiceConversationTicket, handlers: VoiceTransportHandlers): Promise<VoiceTransport> {
  return new Promise((resolve, reject) => {
    const token = encodeURIComponent(ticket.token);
    const source = new EventSource(`${voiceConversationPath(ticket.conversationId, "events")}?token=${token}`);
    let ready = false;
    let closed = false;
    let seq = 0;
    let inflight = 0;
    let queued: Int16Array[] = [];
    let flushTimer: number | undefined;

    const flush = () => {
      flushTimer = undefined;
      if (closed || queued.length === 0) return;
      if (inflight >= HTTP_MAX_INFLIGHT) {
        flushTimer = window.setTimeout(flush, HTTP_AUDIO_FLUSH_MS);
        return;
      }
      const body = concatPcm(queued);
      queued = [];
      inflight++;
      void fetch(`${voiceConversationPath(ticket.conversationId, "audio")}?seq=${seq++}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-voice-token": ticket.token },
        body: body.buffer as ArrayBuffer,
        keepalive: false,
      }).catch(() => undefined).finally(() => {
        inflight--;
      });
    };

    const transport: VoiceTransport = {
      kind: "http",
      sendControl: (message) => {
        void fetch(voiceConversationPath(ticket.conversationId, "control"), {
          method: "POST",
          headers: { "content-type": "application/json", "x-voice-token": ticket.token },
          body: JSON.stringify(message),
        }).catch(() => undefined);
      },
      sendAudio: (pcm) => {
        if (closed) return;
        queued.push(pcm);
        if (flushTimer === undefined) flushTimer = window.setTimeout(flush, HTTP_AUDIO_FLUSH_MS);
      },
      close: () => {
        closed = true;
        if (flushTimer !== undefined) window.clearTimeout(flushTimer);
        source.close();
      },
    };

    const timer = window.setTimeout(() => {
      if (ready) return;
      closed = true;
      source.close();
      reject(new Error("Voice event stream timed out"));
    }, HTTP_HELLO_TIMEOUT_MS);

    source.onmessage = (event) => {
      let message: Record<string, any>;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "audio" && typeof message.data === "string") {
        handlers.onAudio({ genId: message.genId, chunkId: message.chunkId, sampleRate: message.sampleRate, pcm: decodeBase64Pcm(message.data) });
        return;
      }
      if (!ready && message.type === "hello") {
        ready = true;
        window.clearTimeout(timer);
        resolve(transport);
      }
      handlers.onEvent(message);
      if (message.type === "ended") {
        closed = true;
        source.close();
        handlers.onClose("ended");
      }
    };
    source.onerror = () => {
      if (!ready) {
        window.clearTimeout(timer);
        closed = true;
        source.close();
        reject(new Error("Voice event stream failed"));
        return;
      }
      // EventSource retries network drops by itself (the server reattaches), but gives up for good
      // on HTTP errors such as a conversation the server no longer knows.
      if (!closed && source.readyState === EventSource.CLOSED) {
        closed = true;
        if (flushTimer !== undefined) window.clearTimeout(flushTimer);
        handlers.onClose("event stream closed");
      }
    };
  });
}

const WS_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
let webSocketRetryAt = 0;

/** Connects to a voice conversation, preferring WebSocket and falling back to HTTP streaming. */
export async function connectVoiceTransport(
  ticket: VoiceConversationTicket,
  handlers: VoiceTransportHandlers,
  preference: VoiceTransportPreference,
): Promise<VoiceTransport> {
  const tryWebSocket = preference === "websocket" || (preference !== "http" && Date.now() >= webSocketRetryAt);
  if (tryWebSocket && typeof WebSocket !== "undefined") {
    try {
      const transport = await connectWebSocket(ticket, handlers);
      webSocketRetryAt = 0;
      return transport;
    } catch (error) {
      if (preference === "websocket") throw error;
      // A proxy that rejects upgrades will keep rejecting them; reconnect straight over HTTP for a while.
      webSocketRetryAt = Date.now() + WS_RETRY_AFTER_FAILURE_MS;
    }
  }
  return connectHttp(ticket, handlers);
}
