import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserLiveTicket } from "../../shared/browser-live.js";
import { BROWSER_SESSION_IDLE_TIMEOUT_MS, BrowserBroker, type BrowserBrokerLease } from "../browser-broker.js";
import type { BrowserLiveGateway, BrowserLiveViewerListener } from "../browser-live.js";
import { BrowserSessionStore } from "../browser-session-store.js";
import { BrowserHandedOffError, UserBrowserSession } from "../browser-user-session.js";
import { makeTestDir } from "./helpers.js";

const HELD = "The user has this browser right now";

const teardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const teardown of teardowns.splice(0).reverse()) await teardown();
});

/**
 * The user's session over a real broker and session store. The live gateway is a stand-in that
 * gives a ticket for any session and whose views a test opens and ends with `viewers`.
 */
function createUserBrowser() {
  const broker = new BrowserBroker({
    copilotHome: makeTestDir("browser-user-session"),
    runCommand: async () => ({ ok: true, output: "about:blank" }),
    shutdownTarget: async () => ({ ok: true, closeOk: true, terminatedPids: [], killedPids: [], remainingPids: [], clearedRuntimeFiles: 0 }),
  });
  const sessions = new BrowserSessionStore({ browserBroker: broker });
  teardowns.push(() => sessions.closeAll());
  const listeners = new Set<BrowserLiveViewerListener>();
  const createTicket = vi.fn(async (browserSessionId: string): Promise<BrowserLiveTicket> => ({
    browserSessionId,
    token: `ticket-${createTicket.mock.calls.length}`,
    expiresAt: "2026-01-15T12:01:00.000Z",
  }));
  const live = {
    onViewersChanged: (listener: BrowserLiveViewerListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createTicket,
  } as unknown as BrowserLiveGateway;
  const userSession = new UserBrowserSession({ sessions, broker, live });
  const signedIn: BrowserBrokerLease = { context: "authenticated", browserTarget: broker.getAuthenticatedTarget() };
  return {
    broker,
    sessions,
    userSession,
    createTicket,
    signedIn,
    /** What the gateway reports: how many views of the session are open, and whether the one that ended was cut off. */
    viewers: (browserSessionId: string, open: number, dropped = false): void => {
      for (const listener of listeners) listener(browserSessionId, open, dropped);
    },
    /** An agent's operation on the signed-in browser. */
    agentUses: (): Promise<string> =>
      broker.withTarget(signedIn, { toolName: "browser_exec", browserOpId: "op-1", skipReadiness: true }, async () => "ran"),
    /** Closes the session the way the store does when nobody has used it for a while. */
    expire: (): Promise<number> => sessions.sweepIdleSessions(Date.now() + BROWSER_SESSION_IDLE_TIMEOUT_MS),
  };
}

describe("UserBrowserSession.openLiveView", () => {
  it("gives a ticket for a session on the signed-in browser that no chat's tools can use or close", async () => {
    const user = createUserBrowser();

    const ticket = await user.userSession.openLiveView();

    expect(user.sessions.getSession(ticket.browserSessionId)).toMatchObject({
      context: "authenticated",
      browserTarget: user.broker.getAuthenticatedTarget(),
    });
    const use = vi.fn(async () => "used");
    await expect(user.sessions.useSession(ticket.browserSessionId, "chat-session-1", use)).resolves.toMatchObject({ ok: false });
    await expect(user.sessions.closeSession(ticket.browserSessionId, "chat-session-1", true)).resolves.toMatchObject({ ok: false });
    expect(use).not.toHaveBeenCalled();
    expect(user.sessions.getSession(ticket.browserSessionId)).toBeDefined();
  });

  it("makes one session for two requests at once, and gives later requests the same one", async () => {
    const user = createUserBrowser();

    const [first, second] = await Promise.all([user.userSession.openLiveView(), user.userSession.openLiveView()]);
    const third = await user.userSession.openLiveView();

    expect(second.browserSessionId).toBe(first.browserSessionId);
    expect(third.browserSessionId).toBe(first.browserSessionId);
    // Each request gets a ticket of its own.
    expect(new Set([first.token, second.token, third.token]).size).toBe(3);
  });

  it("makes a new session after the store closed the one it had", async () => {
    const user = createUserBrowser();
    const first = await user.userSession.openLiveView();
    await expect(user.expire()).resolves.toBe(1);

    const second = await user.userSession.openLiveView();

    expect(second.browserSessionId).not.toBe(first.browserSessionId);
    expect(user.sessions.getSession(second.browserSessionId)).toBeDefined();
  });

  it("refuses while an agent has handed the signed-in browser to the user, and says what for", async () => {
    const user = createUserBrowser();
    const handBack = user.broker.holdTarget(user.signedIn, "sign in to the store");

    const failure = await user.userSession.openLiveView().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserHandedOffError);
    expect((failure as Error).message).toContain("sign in to the store");
    expect(user.createTicket).not.toHaveBeenCalled();

    handBack();
    await expect(user.userSession.openLiveView()).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("refuses when an agent handed the browser to the user while it was being started for the view", async () => {
    const user = createUserBrowser();
    const makeTicket = user.createTicket.getMockImplementation()!;
    user.createTicket.mockImplementationOnce(async (browserSessionId) => {
      user.broker.holdTarget(user.signedIn, "solve the puzzle");
      return makeTicket(browserSessionId);
    });

    const failure = await user.userSession.openLiveView().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserHandedOffError);
    expect((failure as Error).message).toContain("solve the puzzle");
  });
});

describe("UserBrowserSession and agents", () => {
  it("keeps agents out of the signed-in browser from the first view of it to the last", async () => {
    const user = createUserBrowser();
    const { browserSessionId } = await user.userSession.openLiveView();
    // A ticket alone is not a view, and neither is a view of another session.
    user.viewers("bs_another", 1);
    await expect(user.agentUses()).resolves.toBe("ran");

    user.viewers(browserSessionId, 1);
    await expect(user.agentUses()).rejects.toThrow(HELD);
    // The user can open it on a second device meanwhile.
    await expect(user.userSession.openLiveView()).resolves.toMatchObject({ browserSessionId });
    user.viewers(browserSessionId, 2);
    user.viewers(browserSessionId, 1);
    await expect(user.agentUses()).rejects.toThrow(HELD);

    user.viewers(browserSessionId, 0);
    await expect(user.agentUses()).resolves.toBe("ran");
  });

  it("waits 15 seconds for a view that was cut off to return before it lets agents back in", async () => {
    const user = createUserBrowser();
    const { browserSessionId } = await user.userSession.openLiveView();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    user.viewers(browserSessionId, 1);

    user.viewers(browserSessionId, 0, true);
    await vi.advanceTimersByTimeAsync(14_999);
    await expect(user.agentUses()).rejects.toThrow(HELD);
    // It is back, as on a phone that changed networks: the wait is over, and the browser stays the user's.
    user.viewers(browserSessionId, 1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(user.agentUses()).rejects.toThrow(HELD);

    user.viewers(browserSessionId, 0, true);
    await vi.advanceTimersByTimeAsync(14_999);
    await expect(user.agentUses()).rejects.toThrow(HELD);
    await vi.advanceTimersByTimeAsync(1);
    await expect(user.agentUses()).resolves.toBe("ran");
  });

  it("takes the browser for a view that connected during an agent's handoff once that handoff is over", async () => {
    const user = createUserBrowser();
    const { browserSessionId } = await user.userSession.openLiveView();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const handBack = user.broker.holdTarget(user.signedIn, "solve the puzzle");
    user.viewers(browserSessionId, 1);

    // The agent's handoff stays what it is for as long as it lasts.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(user.broker.heldFor(user.signedIn)).toBe("solve the puzzle");

    // Nothing gets at the browser between the two: the view has it as the handoff gives it up.
    handBack();
    await expect(user.agentUses()).rejects.toThrow(HELD);
    expect(user.broker.heldFor(user.signedIn)).not.toBe("solve the puzzle");
    user.viewers(browserSessionId, 0);
    await expect(user.agentUses()).resolves.toBe("ran");
  });

  it("does not take the browser after an agent's handoff when the view that waited for it has closed", async () => {
    const user = createUserBrowser();
    const { browserSessionId } = await user.userSession.openLiveView();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const handBack = user.broker.holdTarget(user.signedIn, "solve the puzzle");
    user.viewers(browserSessionId, 1);

    user.viewers(browserSessionId, 0);
    handBack();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(user.agentUses()).resolves.toBe("ran");
  });

  it("lets agents back in when the session is closed while a view of it is open", async () => {
    const user = createUserBrowser();
    const { browserSessionId } = await user.userSession.openLiveView();
    user.viewers(browserSessionId, 1);

    await expect(user.expire()).resolves.toBe(1);

    await expect(user.agentUses()).resolves.toBe("ran");
  });
});
