import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export type RestartValidationMode = "deploy" | "operational";

export interface RestartReleaseCandidate {
  id: string;
  root: string;
  commitSha: string;
  source: string;
  dependencyHash: string;
}

export interface RestartSignal {
  requestedAt: string;
  validationMode: RestartValidationMode;
  source?: string;
  releaseCandidate?: RestartReleaseCandidate;
}

function isRestartValidationMode(value: unknown): value is RestartValidationMode {
  return value === "deploy" || value === "operational";
}

export function createRestartSignal(options: {
  validationMode: RestartValidationMode;
  source?: string;
  requestedAt?: string;
  releaseCandidate?: RestartReleaseCandidate;
}): RestartSignal {
  return {
    requestedAt: options.requestedAt ?? new Date().toISOString(),
    validationMode: options.validationMode,
    ...(options.source ? { source: options.source } : {}),
    ...(options.releaseCandidate ? { releaseCandidate: options.releaseCandidate } : {}),
  };
}

export function serializeRestartSignal(options: {
  validationMode: RestartValidationMode;
  source?: string;
  requestedAt?: string;
  releaseCandidate?: RestartReleaseCandidate;
}): string {
  return `${JSON.stringify(createRestartSignal(options))}\n`;
}

function parseReleaseCandidate(value: unknown): RestartReleaseCandidate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
  const root = typeof record.root === "string" && record.root.trim() ? record.root.trim() : "";
  const commitSha = typeof record.commitSha === "string" && record.commitSha.trim()
    ? record.commitSha.trim()
    : "";
  const source = typeof record.source === "string" && record.source.trim() ? record.source.trim() : "";
  const dependencyHash = typeof record.dependencyHash === "string" && record.dependencyHash.trim()
    ? record.dependencyHash.trim()
    : "";
  if (!id || !root || !commitSha || !source || !dependencyHash) return undefined;
  return { id, root, commitSha, source, dependencyHash };
}

export function parseRestartSignalContent(content: string): RestartSignal {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Restart signal is empty");
  }

  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || !isRestartValidationMode(parsed.validationMode)) {
    throw new Error("Restart signal must be typed JSON with a valid validationMode");
  }

  return createRestartSignal({
    validationMode: parsed.validationMode,
    requestedAt: typeof parsed.requestedAt === "string" && parsed.requestedAt.trim()
      ? parsed.requestedAt
      : undefined,
    source: typeof parsed.source === "string" && parsed.source.trim()
      ? parsed.source
      : undefined,
    releaseCandidate: parseReleaseCandidate(parsed.releaseCandidate),
  });
}

export function readRestartSignalFile(signalFile: string): RestartSignal {
  return parseRestartSignalContent(readFileSync(signalFile, "utf-8"));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function consumeRestartSignalFile(signalFile: string, inProgressSignalFile: string): RestartSignal | null {
  try {
    renameSync(signalFile, inProgressSignalFile);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return readRestartSignalFile(inProgressSignalFile);
  } catch (error) {
    try { unlinkSync(inProgressSignalFile); } catch {}
    throw error;
  }
}

export function writeRestartSignalFile(signalFile: string, options: {
  validationMode: RestartValidationMode;
  source?: string;
  releaseCandidate?: RestartReleaseCandidate;
}): void {
  writeFileSync(signalFile, serializeRestartSignal(options));
}
