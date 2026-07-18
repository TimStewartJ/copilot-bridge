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

function tempStateNames(filePath: string): string[] | null {
  try {
    const prefix = `.${basename(filePath)}.`;
    return readdirSync(dirname(filePath)).filter(
      (entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

export function readUnsafeServerCleanupState(
  filePath: string,
): PersistedUnsafeServerCleanupState | null {
  try {
    if (!existsSync(filePath)) {
      const tempNames = tempStateNames(filePath);
      if (tempNames === null) {
        return unreadableState("Unsafe cleanup state could not be inspected; manual recovery is required.");
      }
      return tempNames.length > 0
        ? unreadableState("An incomplete unsafe cleanup state write was found; manual recovery is required.")
        : null;
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<PersistedUnsafeServerCleanupState>;
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
      return unreadableState("Persisted unsafe cleanup state is malformed; manual recovery is required.");
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
  } catch {
    return unreadableState("Persisted unsafe cleanup state is unreadable; manual recovery is required.");
  }
}

export function persistUnsafeServerCleanupState(
  filePath: string,
  root: ProcessIdentity,
  reason: string,
): PersistedUnsafeServerCleanupState {
  const existing = readUnsafeServerCleanupState(filePath);
  if (existing) return existing;

  const state: PersistedUnsafeServerCleanupState = {
    version: 1,
    reason,
    recordedAt: new Date().toISOString(),
    root,
  };
  const tempPath = tempStatePath(filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  return state;
}

export function clearUnsafeServerCleanupState(filePath: string): void {
  rmSync(filePath, { force: true });
  const tempNames = tempStateNames(filePath);
  if (tempNames === null) {
    throw new Error("Unsafe cleanup temporary state files could not be inspected.");
  }
  for (const tempName of tempNames) {
    rmSync(join(dirname(filePath), tempName), { force: true });
  }
}
