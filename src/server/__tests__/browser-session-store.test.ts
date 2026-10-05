import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserContext } from "../browser-broker.js";
import { BrowserSessionStore, sessionLease, type BrowserSessionRecord } from "../browser-session-store.js";
import { testPath } from "./test-paths.js";

const PUBLIC_SLOT = 3;
const IDLE_TIMEOUT_MS = 60_000;

function createFakeBroker() {
  const createSessionTarget = vi.fn(async (context: BrowserContext) => ({
    context,
    browserTarget: {
      sessionName: context === "authenticated" ? "bridge-authenticated" : `bridge-public-${PUBLIC_SLOT}`,
      profileDir: context === "authenticated"
        ? testPath("browser-authenticated")
        : testPath("browser-public", `slot-${PUBLIC_SLOT}`),
    },
    ...(context === "public" ? { publicSlot: PUBLIC_SLOT } : {}),
  }));
  const disposeSessionTarget = vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
  return {
    createSessionTarget,
    disposeSessionTarget,
  };
}

/** A promise the test settles when it wants what waits for it to go on. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("browser session store", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("creates public sessions and cleans them up on close", async () => {
    const browserBroker = createFakeBroker();
    const store = new BrowserSessionStore({ browserBroker: browserBroker as any });

    const session = await store.createSession("copilot-a", "public", "test");

    expect(session).toMatchObject({ context: "public", ownerSessionId: "copilot-a", purpose: "test", publicSlot: PUBLIC_SLOT });
    expect(store.getSession(session.id)).toEqual(session);

    await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });
    expect(store.getSession(session.id)).toBeUndefined();
    // The broker is asked to close the browser the session was given.
    expect(browserBroker.disposeSessionTarget).toHaveBeenCalledTimes(1);
    expect(browserBroker.disposeSessionTarget.mock.calls[0][0]).toEqual(sessionLease(session));
    expect(sessionLease(session)).toEqual({
      context: "public",
      browserTarget: session.browserTarget,
      publicSlot: PUBLIC_SLOT,
    });
    await store.closeAll();
  });

  it("reuses the authenticated target without disposing it", async () => {
    const browserBroker = createFakeBroker();
    const store = new BrowserSessionStore({ browserBroker: browserBroker as any });

    const session = await store.createSession("copilot-a", "authenticated");

    expect(session.context).toBe("authenticated");
    expect(session.publicSlot).toBeUndefined();
    await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });
    expect(browserBroker.disposeSessionTarget).not.toHaveBeenCalled();
    await store.closeAll();
  });

  it("expires idle public sessions during sweep", async () => {
    const browserBroker = createFakeBroker();
    const store = new BrowserSessionStore({
      browserBroker: browserBroker as any,
      idleTimeoutMs: 1,
    });
    const session = await store.createSession("copilot-a", "public");

    const expired = await store.sweepIdleSessions(session.lastUsedAt + 10);

    expect(expired).toBe(1);
    expect(store.getSession(session.id)).toBeUndefined();
    expect(browserBroker.disposeSessionTarget).toHaveBeenCalledTimes(1);
    await store.closeAll();
  });

  it("does not expire a session that becomes active while the sweep closes another", async () => {
    const browserBroker = createFakeBroker();
    const closingFirst = deferred();
    browserBroker.disposeSessionTarget.mockImplementationOnce(() => closingFirst.promise);
    const store = new BrowserSessionStore({ browserBroker: browserBroker as any, idleTimeoutMs: 1 });
    const first = await store.createSession("copilot-a", "public");
    const second = await store.createSession("copilot-a", "authenticated");

    const sweep = store.sweepIdleSessions(second.lastUsedAt + 10);
    const release = deferred();
    const using = store.useSession(second.id, "copilot-a", () => release.promise);
    closingFirst.resolve();

    await expect(sweep).resolves.toBe(1);
    expect(store.getSession(first.id)).toBeUndefined();
    expect(store.getSession(second.id)).toBeDefined();
    release.resolve();
    await using;
    await store.closeAll();
  });

  it("logs interval sweep failures instead of emitting an unhandled rejection", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const browserBroker = createFakeBroker();
    browserBroker.disposeSessionTarget.mockRejectedValueOnce(new Error("idle close failed"));
    const store = new BrowserSessionStore({
      browserBroker: browserBroker as any,
      idleTimeoutMs: 1,
    });
    const session = await store.createSession("copilot-a", "public");

    await vi.advanceTimersByTimeAsync(1);

    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "idle close failed" }));
    expect(store.getSession(session.id)).toBeDefined();

    await store.closeAll();
  });

  it("blocks use and duplicate close while disposal is active", async () => {
    const browserBroker = createFakeBroker();
    let finishDispose!: () => void;
    browserBroker.disposeSessionTarget.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishDispose = resolve;
      }),
    );
    const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
    const session = await store.createSession("copilot-a", "public");

    const closing = store.closeSession(session.id, "copilot-a");
    await Promise.resolve();

    await expect(store.useSession(session.id, "copilot-a", async () => "unused")).resolves.toMatchObject({
      ok: false,
      error: "Browser session is closing",
    });
    await expect(store.closeSession(session.id, "copilot-a")).resolves.toMatchObject({
      ok: false,
      error: "Browser session is already closing",
    });

    finishDispose();
    await expect(closing).resolves.toEqual({ ok: true });
    await store.closeAll();
  });

  it("rejects use and close from another Copilot session", async () => {
    const browserBroker = createFakeBroker();
    const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
    const session = await store.createSession("copilot-a", "authenticated");

    await expect(store.useSession(session.id, "copilot-b", async () => "unused")).resolves.toMatchObject({
      ok: false,
      error: "Browser session belongs to a different Copilot session",
    });
    await expect(store.closeSession(session.id, "copilot-b")).resolves.toMatchObject({
      ok: false,
      error: "Browser session belongs to a different Copilot session",
    });

    await store.closeAll();
  });

  describe("touch", () => {
    const startedAt = Date.parse("2026-03-10T12:00:00Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(startedAt);
    });

    it("counts as a use, so a touched session outlives one that was left alone", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any, idleTimeoutMs: IDLE_TIMEOUT_MS });
      const touched = await store.createSession("copilot-a", "authenticated");
      const untouched = await store.createSession("copilot-a", "authenticated");
      expect(touched.lastUsedAt).toBe(startedAt);

      vi.setSystemTime(startedAt + 50_000);
      store.touch(touched.id);

      expect(store.getSession(touched.id)?.lastUsedAt).toBe(startedAt + 50_000);
      expect(store.getSession(untouched.id)?.lastUsedAt).toBe(startedAt);

      // Both would be idle now without the touch.
      await expect(store.sweepIdleSessions(startedAt + IDLE_TIMEOUT_MS)).resolves.toBe(1);
      expect(store.getSession(untouched.id)).toBeUndefined();
      expect(store.getSession(touched.id)).toBeDefined();

      // The idle limit counts from the touch.
      await expect(store.sweepIdleSessions(startedAt + 50_000 + IDLE_TIMEOUT_MS - 1)).resolves.toBe(0);
      await expect(store.sweepIdleSessions(startedAt + 50_000 + IDLE_TIMEOUT_MS)).resolves.toBe(1);
      expect(store.getSession(touched.id)).toBeUndefined();
      await store.closeAll();
    });

  });

  describe("onSessionClosing", () => {
    /** The order in which a store told its listener and asked the broker to close a browser. */
    function recordCloseOrder(store: BrowserSessionStore, browserBroker: ReturnType<typeof createFakeBroker>) {
      const order: string[] = [];
      store.onSessionClosing((browserSessionId) => {
        order.push(`listener told of ${browserSessionId}`);
      });
      browserBroker.disposeSessionTarget.mockImplementation(async () => {
        order.push("browser closed");
      });
      return order;
    }

    it("tells of a session that is closed explicitly, once, before its browser is closed", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
      const seenByListener: Array<{ record: unknown; browserClosed: boolean }> = [];
      const listener = vi.fn((browserSessionId: string) => {
        seenByListener.push({
          record: store.getSession(browserSessionId),
          browserClosed: browserBroker.disposeSessionTarget.mock.calls.length > 0,
        });
      });
      store.onSessionClosing(listener);
      const order = recordCloseOrder(store, browserBroker);
      const closed = await store.createSession("copilot-a", "public");
      const open = await store.createSession("copilot-a", "authenticated");

      await expect(store.closeSession(closed.id, "copilot-a")).resolves.toEqual({ ok: true });

      expect(listener.mock.calls).toEqual([[closed.id]]);
      // The session and its browser are still there, for the listener to stop what uses them.
      expect(seenByListener).toEqual([{ record: closed, browserClosed: false }]);
      expect(order).toEqual([`listener told of ${closed.id}`, "browser closed"]);
      expect(store.getSession(closed.id)).toBeUndefined();
      expect(store.getSession(open.id)).toBeDefined();

      // Closing what is already closed tells nothing more.
      await expect(store.closeSession(closed.id, "copilot-a")).resolves.toMatchObject({ ok: false });
      expect(listener).toHaveBeenCalledTimes(1);
      await store.closeAll();
    });

    it("tells nothing of a close that is refused", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
      const listener = vi.fn();
      store.onSessionClosing(listener);
      const session = await store.createSession("copilot-a", "public");
      const started = deferred();
      const release = deferred();
      const using = store.useSession(session.id, "copilot-a", async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;

      await expect(store.closeSession(session.id, "copilot-b")).resolves.toMatchObject({ ok: false });
      await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({
        ok: false,
        error: "Browser session is busy",
      });
      await expect(store.closeSession("bs_missing", "copilot-a")).resolves.toMatchObject({ ok: false });

      expect(listener).not.toHaveBeenCalled();
      expect(browserBroker.disposeSessionTarget).not.toHaveBeenCalled();
      expect(store.getSession(session.id)).toBeDefined();

      release.resolve();
      await using;
      await store.closeAll();
    });

    it("tells of sessions that expire as idle, and only those, before their browser is closed", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const startedAt = Date.parse("2026-03-10T12:00:00Z");
      vi.setSystemTime(startedAt);
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any, idleTimeoutMs: IDLE_TIMEOUT_MS });
      const order = recordCloseOrder(store, browserBroker);
      const idle = await store.createSession("copilot-a", "public");
      const touched = await store.createSession("copilot-a", "authenticated");
      const held = await store.createSession("copilot-a", "authenticated");
      const started = deferred();
      const release = deferred();
      const holding = store.holdSession(held.id, async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      vi.setSystemTime(startedAt + 30_000);
      store.touch(touched.id);

      await expect(store.sweepIdleSessions(startedAt + IDLE_TIMEOUT_MS)).resolves.toBe(1);

      expect(order).toEqual([`listener told of ${idle.id}`, "browser closed"]);
      expect(store.getSession(idle.id)).toBeUndefined();
      expect(store.getSession(touched.id)).toBeDefined();
      expect(store.getSession(held.id)).toBeDefined();

      release.resolve();
      await holding;
      await store.closeAll();
    });

    it("tells of every session that closeAll ends, each before its browser is closed", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
      const order = recordCloseOrder(store, browserBroker);
      const publicSession = await store.createSession("copilot-a", "public");
      const authenticatedSession = await store.createSession("copilot-b", "authenticated");

      await store.closeAll();

      expect(order).toEqual([
        `listener told of ${publicSession.id}`,
        "browser closed",
        `listener told of ${authenticatedSession.id}`,
      ]);
      expect(store.getSession(publicSession.id)).toBeUndefined();
      expect(store.getSession(authenticatedSession.id)).toBeUndefined();

      await store.closeAll();
      expect(order).toHaveLength(3);
    });

    // This is the case the listener is for: the Bridge shuts down while a person is in the browser.
    it("tells of a session that closeAll ends while something still uses it", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
      const order = recordCloseOrder(store, browserBroker);
      const session = await store.createSession("copilot-a", "public");
      const started = deferred();
      const release = deferred();
      const holding = store.holdSession(session.id, async () => {
        started.resolve();
        await release.promise;
        return "shown";
      });
      await started.promise;

      await store.closeAll();

      expect(order).toEqual([`listener told of ${session.id}`, "browser closed"]);
      expect(store.getSession(session.id)).toBeUndefined();

      release.resolve();
      await expect(holding).resolves.toMatchObject({ ok: true, value: "shown" });
      expect(store.getSession(session.id)).toBeUndefined();
    });

    // The listener is told before the attempt, when nobody knows yet whether it will succeed.
    it("tells again at every attempt to close a session whose browser does not close at first", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
      const order = recordCloseOrder(store, browserBroker);
      browserBroker.disposeSessionTarget.mockImplementationOnce(async () => {
        order.push("browser did not close");
        throw new Error("public close failed");
      });
      const session = await store.createSession("copilot-a", "public");

      await expect(store.closeSession(session.id, "copilot-a")).rejects.toThrow("public close failed");
      expect(order).toEqual([`listener told of ${session.id}`, "browser did not close"]);
      expect(store.getSession(session.id)).toBeDefined();

      await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });
      expect(order).toEqual([
        `listener told of ${session.id}`,
        "browser did not close",
        `listener told of ${session.id}`,
        "browser closed",
      ]);
      expect(store.getSession(session.id)).toBeUndefined();
      await store.closeAll();
      expect(order).toHaveLength(4);
    });

    it("stops telling a listener that unsubscribed", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
      const unsubscribed = vi.fn();
      const subscribed = vi.fn();
      const unsubscribe = store.onSessionClosing(unsubscribed);
      store.onSessionClosing(subscribed);
      const first = await store.createSession("copilot-a", "authenticated");
      const second = await store.createSession("copilot-a", "authenticated");

      await store.closeSession(first.id, "copilot-a");
      unsubscribe();
      unsubscribe();
      await store.closeSession(second.id, "copilot-a");

      expect(unsubscribed.mock.calls).toEqual([[first.id]]);
      expect(subscribed.mock.calls).toEqual([[first.id], [second.id]]);
      await store.closeAll();
    });

    it("closes the session and tells the other listeners when one listener throws", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
      const failure = new Error("listener failed");
      const before = vi.fn();
      const after = vi.fn();
      store.onSessionClosing(before);
      store.onSessionClosing(() => {
        throw failure;
      });
      store.onSessionClosing(after);
      const session = await store.createSession("copilot-a", "public");

      await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });

      expect(store.getSession(session.id)).toBeUndefined();
      expect(before.mock.calls).toEqual([[session.id]]);
      expect(after.mock.calls).toEqual([[session.id]]);
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), failure);
      expect(browserBroker.disposeSessionTarget).toHaveBeenCalledTimes(1);
      await store.closeAll();
    });
  });

  describe("holdSession", () => {
    const startedAt = Date.parse("2026-03-10T12:00:00Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(startedAt);
    });

    it("runs with the session's record for a caller that is not the owning chat", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any, idleTimeoutMs: IDLE_TIMEOUT_MS });
      const session = await store.createSession("copilot-a", "public", "checkout");
      const show = vi.fn(async (record: BrowserSessionRecord) => `showing ${record.browserTarget.sessionName}`);

      const held = await store.holdSession(session.id, show);

      expect(show).toHaveBeenCalledTimes(1);
      expect(show).toHaveBeenCalledWith({ ...session, activeCount: 1 });
      expect(held).toMatchObject({
        ok: true,
        value: `showing bridge-public-${PUBLIC_SLOT}`,
        record: { id: session.id, ownerSessionId: "copilot-a", browserTarget: session.browserTarget },
      });
      expect(store.getSession(session.id)).toEqual(session);
      await store.closeAll();
    });

    it("keeps the session from expiring or being closed while it runs, and counts as a use", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any, idleTimeoutMs: IDLE_TIMEOUT_MS });
      const listener = vi.fn();
      store.onSessionClosing(listener);
      const session = await store.createSession("copilot-a", "public");
      const started = deferred();
      const release = deferred();
      vi.setSystemTime(startedAt + 1_000);
      const holding = store.holdSession(session.id, async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      expect(store.getSession(session.id)).toMatchObject({ activeCount: 1, lastUsedAt: startedAt + 1_000 });

      // It runs for longer than a session may otherwise go unused.
      const endedAt = startedAt + 10 * IDLE_TIMEOUT_MS;
      vi.setSystemTime(endedAt);
      await expect(store.sweepIdleSessions()).resolves.toBe(0);
      await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({
        ok: false,
        error: "Browser session is busy",
      });
      expect(store.getSession(session.id)).toBeDefined();
      expect(listener).not.toHaveBeenCalled();
      expect(browserBroker.disposeSessionTarget).not.toHaveBeenCalled();

      release.resolve();
      await expect(holding).resolves.toMatchObject({ ok: true });

      // The idle limit counts from its end.
      expect(store.getSession(session.id)).toMatchObject({ activeCount: 0, lastUsedAt: endedAt });
      await expect(store.sweepIdleSessions(endedAt + IDLE_TIMEOUT_MS - 1)).resolves.toBe(0);
      await expect(store.sweepIdleSessions(endedAt + IDLE_TIMEOUT_MS)).resolves.toBe(1);
      expect(listener.mock.calls).toEqual([[session.id]]);
      await store.closeAll();
    });

    it("leaves the session in use until the owning chat's own call has ended too", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any, idleTimeoutMs: IDLE_TIMEOUT_MS });
      const session = await store.createSession("copilot-a", "authenticated");
      const ownerStarted = deferred();
      const ownerRelease = deferred();
      const using = store.useSession(session.id, "copilot-a", async () => {
        ownerStarted.resolve();
        await ownerRelease.promise;
      });
      await ownerStarted.promise;

      await expect(store.holdSession(session.id, async () => "shown")).resolves.toMatchObject({ ok: true, value: "shown" });

      expect(store.getSession(session.id)).toMatchObject({ activeCount: 1 });
      await expect(store.closeSession(session.id, "copilot-a")).resolves.toMatchObject({
        ok: false,
        error: "Browser session is busy",
      });

      ownerRelease.resolve();
      await using;
      await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });
      await store.closeAll();
    });

    it("ends the use when what it runs fails", async () => {
      const browserBroker = createFakeBroker();
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any, idleTimeoutMs: IDLE_TIMEOUT_MS });
      const session = await store.createSession("copilot-a", "public");

      await expect(store.holdSession(session.id, async () => {
        throw new Error("the stream would not start");
      })).rejects.toThrow("the stream would not start");

      expect(store.getSession(session.id)).toMatchObject({ activeCount: 0 });
      await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });
      await store.closeAll();
    });

    it("finds no session under an id it does not know, or one that is closing or closed", async () => {
      const browserBroker = createFakeBroker();
      const finishDispose = deferred();
      browserBroker.disposeSessionTarget.mockImplementationOnce(() => finishDispose.promise);
      const store = new BrowserSessionStore({ browserBroker: browserBroker as any, idleTimeoutMs: IDLE_TIMEOUT_MS });
      const session = await store.createSession("copilot-a", "public");
      const show = vi.fn(async () => "unused");

      await expect(store.holdSession("bs_missing", show)).resolves.toEqual({
        ok: false,
        error: "Browser session not found: bs_missing",
      });

      const closing = store.closeSession(session.id, "copilot-a");
      await Promise.resolve();
      // The record is still there until the browser is gone; nothing new may start on it.
      expect(store.getSession(session.id)).toBeDefined();
      await expect(store.holdSession(session.id, show)).resolves.toEqual({
        ok: false,
        error: `Browser session not found: ${session.id}`,
      });

      finishDispose.resolve();
      await expect(closing).resolves.toEqual({ ok: true });
      await expect(store.holdSession(session.id, show)).resolves.toEqual({
        ok: false,
        error: `Browser session not found: ${session.id}`,
      });
      expect(show).not.toHaveBeenCalled();
      await store.closeAll();
    });
  });

  describe("handoffs", () => {
    it("gives every handoff a field name of its own", async () => {
      const store = new BrowserSessionStore({ browserBroker: createFakeBroker() as any });

      const handoffs = Array.from({ length: 20 }, () => store.beginHandoff("copilot-a", "bs_one", "Sign in"));

      const fieldNames = handoffs.map((handoff) => handoff.fieldName);
      expect(fieldNames.every((fieldName) => typeof fieldName === "string" && fieldName.length > 0)).toBe(true);
      expect(new Set(fieldNames).size).toBe(handoffs.length);
      for (const handoff of handoffs) handoff.end();
      await store.closeAll();
    });

    it("matches a chat's form to its handoff by the form's field names", async () => {
      const store = new BrowserSessionStore({ browserBroker: createFakeBroker() as any });
      const handoff = store.beginHandoff("copilot-a", "bs_one", "Pass the human check on example.com");

      expect(store.matchHandoff("copilot-a", [handoff.fieldName])).toEqual({
        browserSessionId: "bs_one",
        reason: "Pass the human check on example.com",
      });
      expect(store.matchHandoff("copilot-a", ["name", handoff.fieldName, "email"])).toEqual({
        browserSessionId: "bs_one",
        reason: "Pass the human check on example.com",
      });

      // Another form of the same chat, and the same field name in another chat.
      expect(store.matchHandoff("copilot-a", [])).toBeUndefined();
      expect(store.matchHandoff("copilot-a", ["name", "email"])).toBeUndefined();
      expect(store.matchHandoff("copilot-a", [`${handoff.fieldName}_other`])).toBeUndefined();
      expect(store.matchHandoff("copilot-b", [handoff.fieldName])).toBeUndefined();

      handoff.end();
      await store.closeAll();
    });

    it("forgets a handoff once it has ended, and ending it again changes nothing", async () => {
      const store = new BrowserSessionStore({ browserBroker: createFakeBroker() as any });
      const ended = store.beginHandoff("copilot-a", "bs_one", "Sign in");
      const pending = store.beginHandoff("copilot-a", "bs_one", "Approve the prompt");

      ended.end();

      expect(store.matchHandoff("copilot-a", [ended.fieldName])).toBeUndefined();
      expect(store.matchHandoff("copilot-a", [pending.fieldName])).toEqual({
        browserSessionId: "bs_one",
        reason: "Approve the prompt",
      });

      expect(() => ended.end()).not.toThrow();
      expect(store.matchHandoff("copilot-a", [ended.fieldName])).toBeUndefined();
      expect(store.matchHandoff("copilot-a", [pending.fieldName])).toBeDefined();

      pending.end();
      expect(store.matchHandoff("copilot-a", [pending.fieldName])).toBeUndefined();
      await store.closeAll();
    });
  });
});
