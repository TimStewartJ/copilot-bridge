import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProcessIdentity } from "./server/platform.js";

export const UNSAFE_SERVER_CLEANUP_STATE_FILE_NAME = "unsafe-server-cleanup.json";

export type PersistedUnsafeServerCleanupState = {
  version: 1;
  reason: string;
  recordedAt: string;
  root: ProcessIdentity;
};

export type UnsafeCleanupStateFs = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
};

const defaultFs: UnsafeCleanupStateFs = {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
};

function tempStatePath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
}

function unreadableState(reason: string): PersistedUnsafeServerCleanupState {
  return {
    version: 1,
    reason,
    recordedAt: new Date(0).toISOString(),
    root: { pid: 1, startMarker: "unknown" },
  };
}

function tempStateNames(
  filePath: string,
  fs: UnsafeCleanupStateFs,
): string[] | null {
  try {
    const prefix = `.${basename(filePath)}.`;
    return fs.readdirSync(dirname(filePath)).filter(
      (entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

function parseState(raw: string): PersistedUnsafeServerCleanupState {
  const parsed = JSON.parse(raw) as Partial<PersistedUnsafeServerCleanupState>;
  if (
    parsed.version !== 1
    || typeof parsed.reason !== "string"
    || !parsed.reason.trim()
    || typeof parsed.recordedAt !== "string"
    || !Number.isSafeInteger(parsed.root?.pid)
    || (parsed.root?.pid ?? 0) <= 0
    || typeof parsed.root?.startMarker !== "string"
    || !parsed.root.startMarker
  ) {
    throw new Error("Persisted unsafe cleanup state is malformed.");
  }
  return {
    version: 1,
    reason: parsed.reason,
    recordedAt: parsed.recordedAt,
    root: {
      pid: parsed.root.pid,
      startMarker: parsed.root.startMarker,
    },
  };
}

export function readUnsafeServerCleanupState(
  filePath: string,
  fs: UnsafeCleanupStateFs = defaultFs,
): PersistedUnsafeServerCleanupState | null {
  try {
    if (!fs.existsSync(filePath)) {
      const tempNames = tempStateNames(filePath, fs);
      if (tempNames === null) {
        return unreadableState("Unsafe cleanup state could not be inspected; manual recovery is required.");
      }
      return tempNames.length > 0
        ? unreadableState("An incomplete unsafe cleanup state write was found; manual recovery is required.")
        : null;
    }
    return parseState(String(fs.readFileSync(filePath, "utf8")));
  } catch {
    return unreadableState("Persisted unsafe cleanup state is unreadable; manual recovery is required.");
  }
}

function readVerifiableDurableState(
  filePath: string,
  fs: UnsafeCleanupStateFs,
): PersistedUnsafeServerCleanupState | null {
  if (fs.existsSync(filePath)) {
    return parseState(String(fs.readFileSync(filePath, "utf8")));
  }
  const tempNames = tempStateNames(filePath, fs);
  if (tempNames === null) {
    throw new Error("Unsafe cleanup state location could not be inspected.");
  }
  if (tempNames.length > 0) {
    throw new Error("An incomplete unsafe cleanup state marker already exists.");
  }
  return null;
}

export function persistUnsafeServerCleanupState(
  filePath: string,
  root: ProcessIdentity,
  reason: string,
  fs: UnsafeCleanupStateFs = defaultFs,
): PersistedUnsafeServerCleanupState {
  const existing = readVerifiableDurableState(filePath, fs);
  if (existing) return existing;

  const state: PersistedUnsafeServerCleanupState = {
    version: 1,
    reason,
    recordedAt: new Date().toISOString(),
    root,
  };
  const tempPath = tempStatePath(filePath);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // Keep any partially written temp marker. Startup treats it as unsafe, but
    // this call still fails so destructive cleanup never begins.
    throw error;
  }
  const durable = readVerifiableDurableState(filePath, fs);
  if (!durable) {
    throw new Error("Unsafe cleanup state was not durable after atomic rename.");
  }
  return durable;
}

export async function runWithDurableUnsafeCleanupState<T>(
  persist: () => PersistedUnsafeServerCleanupState,
  destructiveCleanup: (state: PersistedUnsafeServerCleanupState) => Promise<T>,
): Promise<
  | { ok: true; state: PersistedUnsafeServerCleanupState; value: T }
  | { ok: false; error: unknown }
> {
  let state: PersistedUnsafeServerCleanupState;
  try {
    state = persist();
  } catch (error) {
    return { ok: false, error };
  }
  return { ok: true, state, value: await destructiveCleanup(state) };
}

export function clearUnsafeServerCleanupState(
  filePath: string,
  fs: UnsafeCleanupStateFs = defaultFs,
): void {
  fs.rmSync(filePath, { force: true });
  const tempNames = tempStateNames(filePath, fs);
  if (tempNames === null) {
    throw new Error("Unsafe cleanup temporary state files could not be inspected.");
  }
  for (const tempName of tempNames) {
    fs.rmSync(join(dirname(filePath), tempName), { force: true });
  }
}
