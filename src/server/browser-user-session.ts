// The user's own session on the signed-in browser: what Settings opens so that a person can sign
// in to sites, or pass a check, in the profile agents use, from whatever device they are on.

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

  /**
   * Permission to open a live view of the signed-in browser. Its session is made on first use
   * and kept, so a view that is opened again finds the browser as it was left; the store closes
   * the session when nobody has used it for a while, which leaves the browser itself running.
   */
  async openLiveView(): Promise<BrowserLiveTicket> {
    // Two views of one browser, each with its own way of ending, would leave it unclear when
    // agents may have the browser back.
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

  /**
   * The browser is the user's while they have it on screen, so no agent navigates it under them,
   * and only then: a view left open in a tab that went away would otherwise keep agents out
   * until the session expired.
   */
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
      // An agent handed this browser to the user in the moment before the view connected. The
      // user has it either way; the view takes it over as that handoff ends, so the agent does
      // not carry on in a page the user is still in.
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
