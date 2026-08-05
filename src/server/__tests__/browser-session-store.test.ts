import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCopilotHome } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();

const execMock = vi.fn();
const execFileMock = vi.fn();
const cpMock = vi.fn();
const mkdirMock = vi.fn();
const readdirMock = vi.fn();
const rmMock = vi.fn();
const statMock = vi.fn();
const readlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const killMock = vi.spyOn(process, "kill");
const destroyCloneOverride = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: any[]) => Promise<void>),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  cp: cpMock,
  mkdir: mkdirMock,
  readdir: readdirMock,
  rm: rmMock,
  stat: statMock,
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  readlinkSync: readlinkSyncMock,
  unlinkSync: unlinkSyncMock,
}));

vi.mock("../agent-browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-browser.js")>();
  return {
    ...actual,
    destroyPersistentCloneBrowserTarget: (...args: Parameters<typeof actual.destroyPersistentCloneBrowserTarget>) =>
      destroyCloneOverride.impl
        ? destroyCloneOverride.impl(...args)
        : actual.destroyPersistentCloneBrowserTarget(...args),
  };
});

describe("browser session store", () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    execFileMock.mockReset();
    cpMock.mockReset();
    mkdirMock.mockReset();
    readdirMock.mockReset();
    rmMock.mockReset();
    statMock.mockReset();
    readlinkSyncMock.mockReset();
    readFileSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    destroyCloneOverride.impl = undefined;
    killMock.mockReset();
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true as never;
      return true as never;
    }) as any);
    cpMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readdirMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    rmMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ mtimeMs: Date.now() });
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates isolated sessions and cleans them up on close", async () => {
    const mod = await import("../browser-session-store.js");
    const store = new mod.BrowserSessionStore({ copilotHome: COPILOT_HOME });

    const session = await store.createSession("copilot-a", "isolated", "test");
    expect(session.mode).toBe("isolated");
    expect(session.browserTarget.sessionName).toContain("-clone-");

    const close = await store.closeSession(session.id, "copilot-a");
    expect(close).toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledWith(
      "agent-browser",
      ["close"],
      expect.objectContaining({
        env: expect.objectContaining({
          AGENT_BROWSER_SESSION: expect.stringContaining("-clone-"),
          AGENT_BROWSER_PROFILE: expect.stringContaining("browser-clones"),
        }),
      }),
      expect.any(Function),
    );
    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
      force: true,
    });
    await store.closeAll();
  });

  it("expires idle isolated sessions during sweep", async () => {
    const mod = await import("../browser-session-store.js");
    const store = new mod.BrowserSessionStore({ copilotHome: COPILOT_HOME, idleTimeoutMs: 1 });

    const session = await store.createSession("copilot-a", "isolated");
    const expired = await store.sweepIdleSessions(session.lastUsedAt + 10);

    expect(expired).toBe(1);
    expect(store.getSession(session.id)).toBeUndefined();
    await store.closeAll();
  });

  it("does not expire a session that becomes active during the same sweep", async () => {
    const mod = await import("../browser-session-store.js");
    const store = new mod.BrowserSessionStore({ copilotHome: COPILOT_HOME, idleTimeoutMs: 1 });

    const first = await store.createSession("copilot-a", "persistent");
    const second = await store.createSession("copilot-a", "persistent");
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

  it("keeps an isolated session retryable when disposal fails", async () => {
    const mod = await import("../browser-session-store.js");
    const store = new mod.BrowserSessionStore({ copilotHome: COPILOT_HOME });
    const session = await store.createSession("copilot-a", "isolated");
    destroyCloneOverride.impl = vi.fn().mockRejectedValueOnce(new Error("clone close failed"));

    await expect(store.closeSession(session.id, "copilot-a")).rejects.toThrow("clone close failed");
    expect(store.getSession(session.id)).toBeDefined();

    destroyCloneOverride.impl = undefined;
    await expect(store.closeSession(session.id, "copilot-a")).resolves.toEqual({ ok: true });
    expect(store.getSession(session.id)).toBeUndefined();
    await store.closeAll();
  });

  it("logs interval sweep failures instead of emitting an unhandled rejection", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await import("../browser-session-store.js");
    const store = new mod.BrowserSessionStore({ copilotHome: COPILOT_HOME, idleTimeoutMs: 1 });
    const session = await store.createSession("copilot-a", "isolated");
    destroyCloneOverride.impl = vi.fn().mockRejectedValueOnce(new Error("idle close failed"));

    await vi.advanceTimersByTimeAsync(1);

    expect(errorSpy).toHaveBeenCalledWith(
      "[browser-session] Idle session sweep failed:",
      expect.objectContaining({ message: "idle close failed" }),
    );
    expect(store.getSession(session.id)).toBeDefined();

    errorSpy.mockRestore();
    destroyCloneOverride.impl = undefined;
    await store.closeAll();
  });

  it("blocks concurrent use and duplicate close while disposal is active", async () => {
    const mod = await import("../browser-session-store.js");
    const store = new mod.BrowserSessionStore({ copilotHome: COPILOT_HOME });
    const session = await store.createSession("copilot-a", "isolated");
    let finishDispose!: () => void;
    destroyCloneOverride.impl = () => new Promise<void>((resolve) => {
      finishDispose = resolve;
    });

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
    destroyCloneOverride.impl = undefined;
    await store.closeAll();
  });
});
