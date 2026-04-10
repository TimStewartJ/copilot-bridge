import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
const execFileMock = vi.fn();
const readlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const killMock = vi.spyOn(process, "kill");

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  readlinkSync: readlinkSyncMock,
  unlinkSync: unlinkSyncMock,
}));

describe("agent-browser wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    execFileMock.mockReset();
    readlinkSyncMock.mockReset();
    readFileSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    killMock.mockReset();
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true as never;
      return true as never;
    }) as any);
  });

  it("passes explicit bridge session env to browser commands", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");

    await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, , options] = execFileMock.mock.calls[0];
    expect(options.env.AGENT_BROWSER_SESSION).toMatch(/^copilot-bridge-/);
    expect(options.env.AGENT_BROWSER_PROFILE).toContain("/tmp/test-copilot/browser-profile");
  });

  it("clears stale dead lock owners and retries once", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "ok", stderr: "" });
        return {} as any;
      });

    readlinkSyncMock.mockReturnValue("host-123");
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(true);
    expect(unlinkSyncMock).toHaveBeenCalledTimes(3);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("kills a live wedged Chrome PID and retries once", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early without writing DevToolsActivePort" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early without writing DevToolsActivePort" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "ok", stderr: "" });
        return {} as any;
      });

    readlinkSyncMock.mockReturnValue("host-123");
    readFileSyncMock.mockReturnValue(
      "chrome\0--user-data-dir=/tmp/test-copilot/browser-profile\0--profile-directory=Default\0",
    );
    const killed: number[] = [];
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true as never;
      killed.push(pid);
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([123]);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("does not kill an unverified live lock owner", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early without writing DevToolsActivePort" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early without writing DevToolsActivePort" });
        return {} as any;
      });

    readlinkSyncMock.mockReturnValue("host-123");
    readFileSyncMock.mockReturnValue("node\0some-other-process.js\0");

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(false);
    expect(killMock).toHaveBeenCalledWith(123, 0);
    expect(killMock).not.toHaveBeenCalledWith(123);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not clear locks when pid exists but is not signalable", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early" });
        return {} as any;
      });

    readlinkSyncMock.mockReturnValue("host-123");
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(false);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith(123, 0);
  });

  it("serializes browser flows through the bridge session lock", async () => {
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
    const order: string[] = [];

    const one = mod.withBridgeBrowserSession(target, async () => {
      order.push("one:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("one:end");
    });
    const two = mod.withBridgeBrowserSession(target, async () => {
      order.push("two:start");
      order.push("two:end");
    });

    await Promise.all([one, two]);
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
  });
});
