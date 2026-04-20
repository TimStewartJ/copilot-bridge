import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface RollbackCheckpointState {
  sha: string;
  createdByCurrentOperation: boolean;
}

export function preserveOrCreateRollbackCheckpoint(
  filePath: string,
  fallbackSha: string,
): RollbackCheckpointState {
  const preservedSha = readRollbackCheckpoint(filePath);
  if (preservedSha) {
    return { sha: preservedSha, createdByCurrentOperation: false };
  }

  if (!fallbackSha) {
    return { sha: "", createdByCurrentOperation: false };
  }

  writeFileSync(filePath, fallbackSha);
  return { sha: fallbackSha, createdByCurrentOperation: true };
}

export function removeRollbackCheckpointIfCreated(
  filePath: string,
  checkpoint: RollbackCheckpointState,
): void {
  if (!checkpoint.createdByCurrentOperation) return;
  clearRollbackCheckpoint(filePath);
}

export function clearRollbackCheckpoint(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {}
}

function readRollbackCheckpoint(filePath: string): string {
  try {
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}
