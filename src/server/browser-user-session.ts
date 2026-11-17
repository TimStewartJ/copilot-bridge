// The user's own session on the signed-in browser, to sign in to sites from any device.

import { randomUUID } from "node:crypto";

import type { BrowserLiveTicket } from "../shared/browser-live.js";
import type { BrowserBroker } from "./browser-broker.js";
import type { BrowserLiveGateway } from "./browser-live.js";
import { sessionLease, type BrowserSessionStore } from "./browser-session-store.js";

/** Owner of the session. No chat has this id, so no agent's tool call can use the session. */
const USER_BROWSER_SESSION_OWNER = `bridge:user:${randomUUID()}`;
const HOLD_PURPOSE = "they opened the signed-in browser from Settings";
/** A view whose connection broke, as on a phone that changes networks, may be back in a moment. */
const VIEWER_GRACE_MS = 15_000;

/** An agent has already given the user this browser, through its own chat. */
export class BrowserHandedOffError extends Error {
  constructor(purpose: string) {
    super(`An agent is waiting for you in this browser (${purpose}). Open it from that chat, or try again once you have answered it.`);
    this.name = "BrowserHandedOffError";
  }
}

export interface UserBrowserSessionOptions {
  sessions: BrowserSessionStore;
  broker: BrowserBroker;
  live: BrowserLiveGateway;
  viewerGraceMs?: number;
}

export class UserBrowserSession {
  private readonly sessions: BrowserSessionStore;
  private readonly broker: BrowserBroker;
  private readonly live: BrowserLiveGateway;
  private readonly viewerGraceMs: number;
  private browserSessionId: string | undefined;
  private opening: Promise<string> | undefined;
  private viewers = 0;
  private releaseHold: (() => void) | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private stopWaitingForHold: (() => void) | undefined;

  constructor(options: UserBrowserSessionOptions) {
    this.sessions = options.sessions;
    this.broker = options.broker;
    this.live = options.live;
    this.viewerGraceMs = options.viewerGraceMs ?? VIEWER_GRACE_MS;
    options.live.onViewersChanged((browserSessionId, viewers, dropped) => {
      if (browserSessionId === this.browserSessionId) this.viewersChanged(viewers, dropped);
    });
    options.sessions.onSessionClosing((browserSessionId) => {
      if (browserSessionId !== this.browserSessionId) return;
      this.browserSessionId = undefined;
      this.release();
    });
  }

  /** Live-view ticket; the session persists so a reopened view finds the browser as left. */
  async openLiveView(): Promise<BrowserLiveTicket> {
    // Two views with separate endings would blur when agents may have the browser back.
    this.refuseWhenHandedOff();
    const ticket = await this.live.createTicket(await this.session());
    // Starting the browser can take a while, and an agent may have handed it off meanwhile.
    this.refuseWhenHandedOff();
    return ticket;
  }

  private refuseWhenHandedOff(): void {
    if (this.releaseHold) return;
    const purpose = this.broker.heldFor({ context: "authenticated", browserTarget: this.broker.getAuthenticatedTarget() });
    if (purpose) throw new BrowserHandedOffError(purpose);
  }

  private async session(): Promise<string> {
    const existing = this.browserSessionId ? this.sessions.getSession(this.browserSessionId) : undefined;
    if (existing) return existing.id;
    this.opening ??= this.sessions
      .createSession(USER_BROWSER_SESSION_OWNER, "authenticated", "Opened from Settings")
      .then((record) => {
        this.browserSessionId = record.id;
        return record.id;
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }

  /** Hold the browser only while viewed, so a forgotten tab can't lock agents out until expiry. */
  private viewersChanged(viewers: number, dropped: boolean): void {
    this.viewers = viewers;
    if (viewers > 0) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      this.hold();
      return;
    }
    if (!dropped) {
      this.release();
      return;
    }
    if (!this.releaseHold || this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      this.release();
    }, this.viewerGraceMs);
    this.graceTimer.unref?.();
  }

  private hold(): void {
    this.stopWaitingForHold?.();
    this.stopWaitingForHold = undefined;
    if (this.releaseHold || this.viewers === 0) return;
    const record = this.browserSessionId ? this.sessions.getSession(this.browserSessionId) : undefined;
    if (!record) return;
    const lease = sessionLease(record);
    try {
      this.releaseHold = this.broker.holdTarget(lease, HOLD_PURPOSE);
    } catch {
      // An agent handed it off just before we connected; take the hold over when that ends.
      this.stopWaitingForHold = this.broker.afterHold(lease, () => this.hold());
    }
  }

  private release(): void {
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.stopWaitingForHold?.();
    this.stopWaitingForHold = undefined;
    this.releaseHold?.();
    this.releaseHold = undefined;
  }
}
