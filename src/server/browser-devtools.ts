// A connection to the DevTools endpoint of a browser agent-browser runs, for the few things
// the Bridge has to ask Chrome itself: see browser-upload.ts and browser-download.ts.

import { WebSocket } from "ws";

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { message?: string };
  sessionId?: string;
}

/** A connection to the browser's DevTools endpoint, for requests and the events of its sessions. */
export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, (message: CdpMessage | Error) => void>();
  closed = false;
  onEvent: (message: CdpMessage) => void = () => {};
  onClose: () => void = () => {};

  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.on("message", (data) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(data.toString()) as CdpMessage;
      } catch {
        return;
      }
      if (message.id === undefined) this.onEvent(message);
      else this.pending.get(message.id)?.(message);
    });
    socket.on("close", () => {
      this.closed = true;
      for (const settle of [...this.pending.values()]) settle(new Error("the browser's DevTools connection closed"));
      this.onClose();
    });
    // A close always follows; without a listener the error would be thrown.
    socket.on("error", () => {});
  }

  static open(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
      const connection = new CdpConnection(socket, timeoutMs);
      socket.once("open", () => resolve(connection));
      socket.once("close", () => reject(new Error("the browser's DevTools address did not answer")));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("the browser's DevTools connection closed"));
      const id = ++this.nextId;
      const timer = setTimeout(
        () => this.pending.get(id)?.(new Error(`the browser did not answer ${method}`)),
        this.timeoutMs,
      );
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (message instanceof Error) reject(message);
        else if (message.error) reject(new Error(`${method}: ${message.error.message ?? "failed"}`));
        else resolve(message.result ?? {});
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** The browser's DevTools address when it is on this machine, which is the only place the Bridge connects to. */
export function localDevToolsUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    return url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
