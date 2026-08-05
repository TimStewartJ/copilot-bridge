import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function hasPersistentRollbackFailureState(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export function markPersistentRollbackFailureState(filePath: string): void {
  if (hasPersistentRollbackFailureState(filePath)) return;
  const dir = dirname(filePath);
  const tempPath = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(tempPath, `${new Date().toISOString()}\n`, "utf8");
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function clearPersistentRollbackFailureState(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}
