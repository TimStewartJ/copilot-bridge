import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserContext } from "../browser-broker.js";
import { BrowserSessionStore } from "../browser-session-store.js";

function createFakeBroker() {
  const createSessionTarget = vi.fn(async (context: BrowserContext) => ({
    context,
    browserTarget: {
      sessionName: context === "authenticated" ? "bridge-authenticated" : "bridge-public-1234",
      profileDir: context === "authenticated" ? "C:\\browser-authenticated" : "C:\\browser-public\\profile-1234",
    },
    ...(context === "public" ? { publicTargetId: "1234" } : {}),
  }));
  const disposeSessionTarget = vi.fn(async () => undefined);
  return {
    createSessionTarget,
    disposeSessionTarget,
  };
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

    expect(session).toMatchObject({
      context: "public",
      mode: "isolated",
      publicTargetId: "1234",
    });
    expect(browserBroker.createSessionTarget).toHaveBeenCalledWith("public");

    await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });
    expect(browserBroker.disposeSessionTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "public",
        publicTargetId: "1234",
      }),
      expect.objectContaining({
        toolName: "browser_session_close",
        browserOpId: session.id,
      }),
    );
    await store.closeAll();
  });

  it("reuses the authenticated target without disposing it", async () => {
    const browserBroker = createFakeBroker();
    const store = new BrowserSessionStore({ browserBroker: browserBroker as any });

    const session = await store.createSession("copilot-a", "authenticated");

    expect(session).toMatchObject({
      context: "authenticated",
      mode: "persistent",
      publicTargetId: undefined,
    });
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

  it("does not expire a session that becomes active during the same sweep", async () => {
    const browserBroker = createFakeBroker();
    const store = new BrowserSessionStore({
      browserBroker: browserBroker as any,
      idleTimeoutMs: 1,
    });
    const first = await store.createSession("copilot-a", "authenticated");
    const second = await store.createSession("copilot-a", "authenticated");
    const sessions = (store as any).sessions as Map<string, any>;
    const originalGet = sessions.get.bind(sessions);
    let activated = false;
    sessions.get = vi.fn((id: string) => {
      const current = originalGet(id);
      if (id === second.id && current && !activated) {
        activated = true;
        current.activeCount = 1;
        current.lastUsedAt = Date.now();
      }
      return current;
    });

    const expired = await store.sweepIdleSessions(second.lastUsedAt + 10);

    expect(expired).toBe(1);
    expect(store.getSession(first.id)).toBeUndefined();
    expect(store.getSession(second.id)).toBeDefined();
    await store.closeAll();
  });

  it("keeps a public session retryable when disposal fails", async () => {
    const browserBroker = createFakeBroker();
    browserBroker.disposeSessionTarget.mockRejectedValueOnce(new Error("public close failed"));
    const store = new BrowserSessionStore({ browserBroker: browserBroker as any });
    const session = await store.createSession("copilot-a", "public");

    await expect(store.closeSession(session.id, "copilot-a")).rejects.toThrow("public close failed");
    expect(store.getSession(session.id)).toBeDefined();

    await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });
    expect(store.getSession(session.id)).toBeUndefined();
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

    expect(errorSpy).toHaveBeenCalledWith(
      "[browser-session] Idle session sweep failed:",
      expect.objectContaining({ message: "idle close failed" }),
    );
    expect(store.getSession(session.id)).toBeDefined();

    await store.closeAll();
  });

  it("blocks use and duplicate close while disposal is active", async () => {
    const browserBroker = createFakeBroker();
    let finishDispose!: (value?: undefined) => void;
    browserBroker.disposeSessionTarget.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => {
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
});
