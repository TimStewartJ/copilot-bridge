import type { AddressInfo } from "node:net";
import { expect, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

interface CdpRequest {
  id: number;
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

/**
 * Stands in for Chrome's DevTools endpoint: one tab (session `page`) with one frame of another
 * site in it (session `frame`).
 */
export class FakeChrome {
  readonly server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  readonly requests: CdpRequest[] = [];
  private socket: WebSocket | undefined;
  /** Requests answered only when the test says so. */
  held: string[] = [];
  /** Requests answered with an error. */
  failing: string[] = [];
  /** The attributes of every node, names and values in turn. */
  attributes: string[] = [];

  constructor() {
    this.server.on("connection", (socket) => {
      this.socket = socket;
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as CdpRequest;
        this.requests.push(request);
        if (this.held.includes(request.method)) return;
        if (this.failing.includes(request.method)) {
          socket.send(JSON.stringify({ id: request.id, error: { message: "No node with given id found" } }));
          return;
        }
        if (request.method === "Target.setAutoAttach") {
          // Asked of the browser, Chrome attaches the client to its tabs; asked of a tab, to its frames.
          if (!request.sessionId) this.event("Target.attachedToTarget", { sessionId: "page", targetInfo: { type: "page" } });
          else if (request.sessionId === "page") this.event("Target.attachedToTarget", { sessionId: "frame", targetInfo: { type: "iframe" } }, "page");
        }
        const result = request.method === "Target.attachToTarget"
          ? { sessionId: "page" }
          : request.method === "DOM.describeNode" ? { node: { attributes: this.attributes } } : {};
        socket.send(JSON.stringify({ id: request.id, result }));
      });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/devtools/browser/fake`;
  }

  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.socket?.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }

  /** The requests of one kind, as `session:detail`. */
  sent(method: string, detail: (params: Record<string, any>) => unknown = () => ""): string[] {
    return this.requests.filter((request) => request.method === method)
      .map((request) => `${request.sessionId}:${String(detail(request.params))}`);
  }

  reset(): void {
    this.requests.length = 0;
    this.held = [];
    this.failing = [];
    this.attributes = [];
    this.socket?.terminate();
    this.socket = undefined;
  }

  /** Resolves once the Bridge has closed its connection. */
  async disconnected(): Promise<void> {
    await vi.waitFor(() => expect(this.server.clients.size).toBe(0));
  }
}
