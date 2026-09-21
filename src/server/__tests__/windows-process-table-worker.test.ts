import { describe, expect, it, vi } from "vitest";
import { enumerateWindowsProcessTable, type WindowsProcessTableApi } from "../windows-process-table-worker.js";

const EPOCH_OFFSET = 504_911_232_000_000_000n;
function fixture(rows: { pid: number; ppid: number; time?: bigint; accessible?: boolean }[]) {
  let index = 0;
  const snapshot = { snapshot: true };
  const read = (buffer: Buffer) => {
    const row = rows[index];
    if (!row) return false;
    buffer.writeUInt32LE(row.pid, 8);
    buffer.writeUInt32LE(row.ppid, 32);
    return true;
  };
  const api: WindowsProcessTableApi = {
    entrySize: 568, pidOffset: 8, parentPidOffset: 32,
    snapshot: vi.fn(() => snapshot),
    invalidHandle: (handle) => handle === undefined,
    first: vi.fn((_handle, buffer) => { index = 0; expect(buffer.readUInt32LE(0)).toBe(568); return read(buffer); }),
    next: vi.fn((_handle, buffer) => { index++; return read(buffer); }),
    open: vi.fn((pid) => rows.find((row) => row.pid === pid && row.accessible !== false)),
    creationTime: vi.fn((handle) => {
      const row = rows.find((row) => row === handle);
      return row?.time;
    }),
    now: () => 10_000n,
    close: vi.fn(),
    lastError: vi.fn(() => 18),
  };
  return { api, snapshot };
}

describe("native Windows process enumeration with controlled APIs", () => {
  it("returns parent edges and CIM-compatible microsecond birth markers and closes every handle", () => {
    const rows = [{ pid: 100, ppid: 1, time: 1009n }, { pid: 101, ppid: 100, time: 1023n }];
    const f = fixture(rows);
    expect(enumerateWindowsProcessTable(f.api)).toEqual([
      { pid: 100, ppid: 1, startMarker: (EPOCH_OFFSET + 1000n).toString() },
      { pid: 101, ppid: 100, startMarker: (EPOCH_OFFSET + 1020n).toString() },
    ]);
    expect(f.api.close).toHaveBeenCalledTimes(3);
    expect(f.api.close).toHaveBeenLastCalledWith(f.snapshot);
  });

  it("does not attach a recycled PID's newer birth time to an old snapshot edge", () => {
    const f = fixture([{ pid: 100, ppid: 1, time: 11_000n }]);
    expect(enumerateWindowsProcessTable(f.api)).toEqual([{ pid: 100, ppid: 1, startMarker: "",
      identityError: "Process was created after the parent snapshot began" }]);
  });

  it("retains inaccessible or missing creation times as unknown instead of dropping a possible survivor", () => {
    const f = fixture([{ pid: 100, ppid: 1, accessible: false }, { pid: 101, ppid: 100 }]);
    expect(enumerateWindowsProcessTable(f.api)).toEqual([
      { pid: 100, ppid: 1, startMarker: "", identityError: "OpenProcess failed with Windows error 18" },
      { pid: 101, ppid: 100, startMarker: "", identityError: "GetProcessTimes failed with Windows error 18" },
    ]);
    expect(f.api.close).toHaveBeenCalledTimes(2);
  });

  it("excludes only the system idle PID zero", () => {
    const f = fixture([{ pid: 0, ppid: 0, time: 1n }, { pid: 4, ppid: 0, accessible: false }]);
    expect(enumerateWindowsProcessTable(f.api)).toEqual([{ pid: 4, ppid: 0, startMarker: "", identityError: "OpenProcess failed with Windows error 18" }]);
    expect(f.api.open).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("rejects a failed snapshot instead of returning an empty table", () => {
    const f = fixture([]);
    f.api.snapshot = () => undefined;
    f.api.lastError = () => 5;
    expect(() => enumerateWindowsProcessTable(f.api)).toThrow("CreateToolhelp32Snapshot failed with Windows error 5");
    expect(f.api.close).not.toHaveBeenCalled();
  });

  it("rejects an incomplete enumeration instead of declaring unseen processes exited", () => {
    const f = fixture([{ pid: 100, ppid: 1, time: 1000n }]);
    f.api.lastError = () => 5;
    expect(() => enumerateWindowsProcessTable(f.api)).toThrow("Process32 enumeration failed with Windows error 5");
    expect(f.api.close).toHaveBeenLastCalledWith(f.snapshot);
  });

  it("closes the process and snapshot handles when reading times throws", () => {
    const f = fixture([{ pid: 100, ppid: 1, time: 1000n }]);
    f.api.creationTime = () => { throw new Error("controlled times failure"); };
    expect(() => enumerateWindowsProcessTable(f.api)).toThrow("controlled times failure");
    expect(f.api.close).toHaveBeenCalledTimes(2);
  });

  it("reports close failure without attempting to close that handle twice", () => {
    const rows = [{ pid: 100, ppid: 1, time: 1000n }];
    const f = fixture(rows);
    f.api.close = vi.fn((handle) => { if (handle === rows[0]) throw new Error("close failure"); });
    expect(() => enumerateWindowsProcessTable(f.api)).toThrow("close failure");
    expect(f.api.close).toHaveBeenCalledTimes(2);
    expect(f.api.close).toHaveBeenLastCalledWith(f.snapshot);
  });
});
