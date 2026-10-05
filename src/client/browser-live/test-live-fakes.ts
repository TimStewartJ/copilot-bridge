import type { BrowserLiveClientMessage, BrowserLiveServerMessage, BrowserLiveTicket } from "../../shared/browser-live.js";
import type { BrowserLiveDeps, LiveSocket } from "./live-connection";
import type { LiveTimers } from "./mouse-input";

/** Test doubles for the live browser view: a socket the test drives, and a clock it advances. */

export class FakeLiveSocket implements LiveSocket {
  readyState = 0;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  readonly sent: BrowserLiveClientMessage[] = [];
  closedByClient = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as BrowserLiveClientMessage);
  }

  close(): void {
    this.readyState = 3;
    this.closedByClient = true;
  }

  /** The server accepted the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: BrowserLiveServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** The connection went away without the server saying why. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  sentOfType<T extends BrowserLiveClientMessage["type"]>(type: T): Array<Extract<BrowserLiveClientMessage, { type: T }>> {
    return this.sent.filter((message): message is Extract<BrowserLiveClientMessage, { type: T }> => message.type === type);
  }
}

export interface ManualTimers {
  timers: LiveTimers;
  /** Moves the clock forward and runs every timer that comes due, in order. */
  advance(ms: number): void;
  pending(): number;
}

export function createManualTimers(): ManualTimers {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      now: () => now,
      setTimeout: (callback, delayMs) => {
        const id = nextId;
        nextId += 1;
        scheduled.set(id, { at: now + Math.max(0, delayMs), callback });
        return id;
      },
      clearTimeout: (handle) => {
        scheduled.delete(handle as number);
      },
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        scheduled.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    pending: () => scheduled.size,
  };
}

export interface FakeLiveNetwork {
  deps: BrowserLiveDeps;
  clock: ManualTimers;
  sockets: FakeLiveSocket[];
  /** Browser session ids a ticket was asked for, in order. */
  ticketRequests: string[];
  /** Replaces how the next ticket requests answer. */
  setTicketResponder(responder: (browserSessionId: string, attempt: number) => Promise<BrowserLiveTicket>): void;
  latestSocket(): FakeLiveSocket;
}

export function createFakeLiveNetwork(): FakeLiveNetwork {
  const clock = createManualTimers();
  const sockets: FakeLiveSocket[] = [];
  const ticketRequests: string[] = [];
  let responder = async (browserSessionId: string, attempt: number): Promise<BrowserLiveTicket> => ({
    browserSessionId,
    token: `token-${attempt}`,
    expiresAt: "2026-01-01T00:01:00.000Z",
  });
  return {
    clock,
    sockets,
    ticketRequests,
    setTicketResponder(next) {
      responder = next;
    },
    latestSocket() {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error("No live socket has been opened");
      return socket;
    },
    deps: {
      requestTicket: (browserSessionId) => {
        ticketRequests.push(browserSessionId);
        return responder(browserSessionId, ticketRequests.length);
      },
      buildUrl: (ticket) => `ws://bridge.test/live?browserSessionId=${ticket.browserSessionId}&token=${ticket.token}`,
      createSocket: (url) => {
        const socket = new FakeLiveSocket(url);
        sockets.push(socket);
        return socket;
      },
      timers: clock.timers,
    },
  };
}
