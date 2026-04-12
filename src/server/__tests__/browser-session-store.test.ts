import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("creates isolated sessions and cleans them up on close", async () => {
    const mod = await import("../browser-session-store.js");
    const store = new mod.BrowserSessionStore({ copilotHome: "/tmp/test-copilot" });

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
    const store = new mod.BrowserSessionStore({ copilotHome: "/tmp/test-copilot", idleTimeoutMs: 1 });

    const session = await store.createSession("copilot-a", "isolated");
    const expired = await store.sweepIdleSessions(session.lastUsedAt + 10);

    expect(expired).toBe(1);
    expect(store.getSession(session.id)).toBeUndefined();
    await store.closeAll();
  });

  it("does not expire a session that becomes active during the same sweep", async () => {
    const mod = await import("../browser-session-store.js");
    const store = new mod.BrowserSessionStore({ copilotHome: "/tmp/test-copilot", idleTimeoutMs: 1 });

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
});
