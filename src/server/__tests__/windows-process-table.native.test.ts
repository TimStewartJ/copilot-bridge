import { afterAll, describe, expect, it } from "vitest";
import { readNativeWindowsProcessTable, resetWindowsProcessTableForTests } from "../windows-process-table.js";

const windows = process.platform === "win32";
afterAll(async () => { await resetWindowsProcessTableForTests(); });

describe("Windows process snapshots on the actual host", () => {
  it.runIf(windows)("returns the current process with its real parent and persisted-marker precision", async () => {
    const entries = await readNativeWindowsProcessTable(20_000);
    const own = entries.find((entry) => entry.pid === process.pid);
    expect(own?.ppid).toBe(process.ppid);
    expect(own?.startMarker).toMatch(/^\d+0$/);
    expect(new Set(entries.map((entry) => entry.pid)).size).toBe(entries.length);
  });

  it.runIf(windows)("performs independent snapshots on the same worker and shuts down cleanly", async () => {
    const [first, second] = await Promise.all([
      readNativeWindowsProcessTable(20_000),
      readNativeWindowsProcessTable(20_000),
    ]);
    expect(first.find((entry) => entry.pid === process.pid)).toEqual(second.find((entry) => entry.pid === process.pid));
    await resetWindowsProcessTableForTests();
    expect((await readNativeWindowsProcessTable(20_000)).some((entry) => entry.pid === process.pid)).toBe(true);
  });
});
