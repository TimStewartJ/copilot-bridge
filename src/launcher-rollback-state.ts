import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function hasPersistentRollbackFailureState(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

export function markPersistentRollbackFailureState(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, new Date().toISOString());
  } catch {}
}

export function clearPersistentRollbackFailureState(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {}
}
