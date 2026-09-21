import { parentPort, workerData } from "node:worker_threads";

export const WINDOWS_PROCESS_TABLE_WORKER_FLAG = "bridgeWindowsProcessTableWorker";

export interface WindowsProcessTableEntry {
  pid: number;
  ppid: number;
  startMarker: string;
  identityError?: string;
}

export interface WindowsProcessTableApi {
  entrySize: number;
  pidOffset: number;
  parentPidOffset: number;
  snapshot(): unknown;
  invalidHandle(handle: unknown): boolean;
  first(handle: unknown, entry: Buffer): boolean;
  next(handle: unknown, entry: Buffer): boolean;
  open(pid: number): unknown;
  creationTime(handle: unknown): bigint | undefined;
  now(): bigint;
  close(handle: unknown): void;
  lastError(): number;
}

const FILETIME_TO_DOTNET_TICKS = 504_911_232_000_000_000n;
const ERROR_NO_MORE_FILES = 18;

export async function loadWindowsProcessTableApi(): Promise<WindowsProcessTableApi> {
  const imported = await import("koffi");
  const koffi = imported.default ?? imported;
  const kernel32 = koffi.load("kernel32.dll");
  const entry = koffi.struct({
    dwSize: "uint32", cntUsage: "uint32", th32ProcessID: "uint32",
    th32DefaultHeapID: "uintptr_t", th32ModuleID: "uint32", cntThreads: "uint32",
    th32ParentProcessID: "uint32", pcPriClassBase: "int32", dwFlags: "uint32",
    szExeFile: koffi.array("uint16", 260),
  });
  const pidOffset = entry.members?.th32ProcessID?.offset;
  const parentPidOffset = entry.members?.th32ParentProcessID?.offset;
  if (pidOffset === undefined || parentPidOffset === undefined) throw new Error("Cannot resolve Windows process entry layout");
  const snapshot = kernel32.func("void* __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)");
  const first = kernel32.func("int __stdcall Process32FirstW(void* snapshot, void* entry)");
  const next = kernel32.func("int __stdcall Process32NextW(void* snapshot, void* entry)");
  const open = kernel32.func("void* __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)");
  const times = kernel32.func("int __stdcall GetProcessTimes(void* process, void* creation, void* exit, void* kernel, void* user)");
  const now = kernel32.func("void __stdcall GetSystemTimePreciseAsFileTime(void* time)");
  const close = kernel32.func("int __stdcall CloseHandle(void* handle)");
  const lastError = kernel32.func("uint32 __stdcall GetLastError()");
  const invalid = BigInt.asUintN(koffi.sizeof("uintptr_t") * 8, -1n);
  return {
    entrySize: entry.size,
    pidOffset,
    parentPidOffset,
    snapshot: () => snapshot(0x00000002, 0),
    invalidHandle: (handle) => handle === null || handle === undefined || koffi.address(handle) === invalid,
    first: (handle, buffer) => first(handle, buffer) !== 0,
    next: (handle, buffer) => next(handle, buffer) !== 0,
    open: (pid) => open(0x1000, 0, pid),
    creationTime: (handle) => {
      const buffer = Buffer.alloc(32);
      return times(handle, buffer.subarray(0, 8), buffer.subarray(8, 16), buffer.subarray(16, 24), buffer.subarray(24, 32)) !== 0
        ? buffer.readBigUInt64LE(0) : undefined;
    },
    now: () => {
      const buffer = Buffer.alloc(8);
      now(buffer);
      return buffer.readBigUInt64LE(0);
    },
    close: (handle) => {
      if (close(handle) === 0) throw new Error(`CloseHandle failed with Windows error ${lastError()}`);
    },
    lastError: () => lastError(),
  };
}

function withHandle<T>(api: WindowsProcessTableApi, handle: unknown, work: () => T): T {
  let result: T;
  try {
    result = work();
  } catch (error) {
    try {
      api.close(handle);
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Windows process snapshot failed and its handle could not be closed");
    }
    throw error;
  }
  api.close(handle);
  return result;
}

export function enumerateWindowsProcessTable(api: WindowsProcessTableApi): WindowsProcessTableEntry[] {
  // A PID opened after the snapshot may already have been recycled. Never attach its new birth time to an old parent edge.
  const startedAt = api.now();
  const snapshot = api.snapshot();
  if (api.invalidHandle(snapshot)) throw new Error(`CreateToolhelp32Snapshot failed with Windows error ${api.lastError()}`);
  return withHandle(api, snapshot, () => {
    const entries: WindowsProcessTableEntry[] = [];
    const entry = Buffer.alloc(api.entrySize);
    entry.writeUInt32LE(api.entrySize, 0);
    let present = api.first(snapshot, entry);
    while (present) {
      const pid = entry.readUInt32LE(api.pidOffset);
      const ppid = entry.readUInt32LE(api.parentPidOffset);
      if (pid > 0) {
        const handle = api.open(pid);
        let identityError: string | undefined;
        let created: bigint | undefined;
        if (api.invalidHandle(handle)) {
          identityError = `OpenProcess failed with Windows error ${api.lastError()}`;
        } else {
          created = withHandle(api, handle, () => {
            const time = api.creationTime(handle);
            if (time === undefined) identityError = `GetProcessTimes failed with Windows error ${api.lastError()}`;
            return time;
          });
        }
        if (created !== undefined && created > startedAt) identityError = "Process was created after the parent snapshot began";
        // CIM birth markers have microsecond precision; keep persisted identities compatible.
        entries.push({ pid, ppid, startMarker: created !== undefined && created > 0n && created <= startedAt
          ? ((created / 10n) * 10n + FILETIME_TO_DOTNET_TICKS).toString() : "", ...(identityError ? { identityError } : {}) });
      }
      present = api.next(snapshot, entry);
    }
    const error = api.lastError();
    if (error !== ERROR_NO_MORE_FILES) throw new Error(`Process32 enumeration failed with Windows error ${error}`);
    return entries;
  });
}

if (parentPort && workerData?.[WINDOWS_PROCESS_TABLE_WORKER_FLAG] === true) {
  const port = parentPort;
  const api = loadWindowsProcessTableApi();
  port.on("message", ({ id }: { id: number }) => {
    void api.then((loaded) => {
      const entries = enumerateWindowsProcessTable(loaded);
      if (!entries.some((entry) => entry.pid === process.pid)) throw new Error("Native Windows snapshot omitted the calling process");
      port.postMessage({ id, entries });
    }).catch((error: unknown) => {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    });
  });
}
