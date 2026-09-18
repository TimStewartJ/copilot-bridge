import { afterEach, describe, expect, it, vi } from "vitest";
import { KeepAwake } from "../keep-alive.js";
import type { WindowsKeepAwakeApi } from "../platform.js";

const ES_CONTINUOUS = 0x80000000;
const AWAKE = ES_CONTINUOUS | 0x1 | 0x2;

function createKeepAwake(loadApi?: () => Promise<WindowsKeepAwakeApi>) {
  const calls: string[] = [];
  const api: WindowsKeepAwakeApi = {
    setThreadExecutionState: (flags) => {
      calls.push(`state:${flags === AWAKE ? "awake" : flags === ES_CONTINUOUS ? "released" : flags}`);
      return 1;
    },
    moveMouse: (dx, dy) => {
      calls.push(`mouse:${dx},${dy}`);
    },
  };
  const warnings: string[] = [];
  const load = vi.fn(loadApi ?? (() => Promise.resolve(api)));
  const keepAwake = new KeepAwake(load, { log: () => {}, warn: (message) => warnings.push(message) });
  return { keepAwake, calls, warnings, load };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KeepAwake", () => {
  it("holds the machine awake while sessions are active and releases it when they go idle", async () => {
    vi.useFakeTimers();
    const { keepAwake, calls, load } = createKeepAwake();

    keepAwake.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["state:awake", "mouse:1,0", "mouse:-1,0"]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.slice(3)).toEqual(["mouse:1,0", "mouse:-1,0"]);

    keepAwake.setActive(false);
    expect(calls.at(-1)).toBe("state:released");
    const settled = calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls).toHaveLength(settled);

    keepAwake.setActive(true);
    expect(calls.slice(settled)).toEqual(["state:awake", "mouse:1,0", "mouse:-1,0"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("applies the latest state when sessions go idle before the bindings finish loading", async () => {
    let finishLoading!: (api: WindowsKeepAwakeApi) => void;
    const calls: string[] = [];
    const { keepAwake } = createKeepAwake(() => new Promise((resolve) => {
      finishLoading = resolve;
    }));

    keepAwake.setActive(true);
    keepAwake.setActive(false);
    finishLoading({
      setThreadExecutionState: (flags) => {
        calls.push(flags === ES_CONTINUOUS ? "released" : "awake");
        return 1;
      },
      moveMouse: () => calls.push("mouse"),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["released"]);
  });

  it("warns instead of failing when the bindings are unavailable, and retries on the next activity", async () => {
    const { keepAwake, warnings, load } = createKeepAwake(() => Promise.reject(new Error("koffi missing")));

    keepAwake.setActive(true);
    await vi.waitFor(() => expect(warnings).toHaveLength(1));
    expect(warnings[0]).toContain("koffi missing");

    keepAwake.setActive(false);
    keepAwake.setActive(true);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
