import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RESTART_IN_PROGRESS_FILE_NAME, RESTART_SIGNAL_FILE_NAME } from "./restart-state.js";

export type RestartValidationMode = "deploy" | "operational";
/** A launcher from before restart-when-idle only picks up a newer release candidate for this source. */
export const DEPLOY_RESTART_SOURCE = "staging_deploy_batch";

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
  requestId?: string;
  source?: string;
  releaseCandidate?: RestartReleaseCandidate;
}

export type RestartSignalConsumption =
  | { status: "none" }
  | { status: "retryable-error"; stage: "claim" | "read"; error: unknown }
  | {
      status: "invalid";
      error: Error;
      requestId?: string;
      releaseCandidateId?: string;
    }
  | { status: "claimed"; signal: RestartSignal };

function isRestartValidationMode(value: unknown): value is RestartValidationMode {
  return value === "deploy" || value === "operational";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createRestartSignal(options: {
  validationMode: RestartValidationMode;
  requestId?: string;
  source?: string;
  requestedAt?: string;
  releaseCandidate?: RestartReleaseCandidate;
}): RestartSignal {
  return {
    requestedAt: options.requestedAt ?? new Date().toISOString(),
    validationMode: options.validationMode,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.releaseCandidate ? { releaseCandidate: options.releaseCandidate } : {}),
  };
}

export function serializeRestartSignal(options: {
  validationMode: RestartValidationMode;
  requestId?: string;
  source?: string;
  requestedAt?: string;
  releaseCandidate?: RestartReleaseCandidate;
}): string {
  return `${JSON.stringify(createRestartSignal(options))}\n`;
}

function parseReleaseCandidate(value: unknown): RestartReleaseCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Restart signal releaseCandidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const id = nonEmptyString(record.id);
  const root = nonEmptyString(record.root);
  const commitSha = nonEmptyString(record.commitSha);
  const source = nonEmptyString(record.source);
  const dependencyHash = nonEmptyString(record.dependencyHash);
  if (!id || !root || !commitSha || !source || !dependencyHash) {
    throw new Error(
      "Restart signal releaseCandidate must include non-empty id, root, commitSha, source, and dependencyHash fields",
    );
  }
  return { id, root, commitSha, source, dependencyHash };
}

export function parseRestartSignalContent(content: string): RestartSignal {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Restart signal is empty");
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Restart signal must be typed JSON with a valid validationMode");
  }
  const record = parsed as Record<string, unknown>;
  if (!isRestartValidationMode(record.validationMode)) {
    throw new Error("Restart signal must be typed JSON with a valid validationMode");
  }
  const hasRequestId = Object.hasOwn(record, "requestId");
  const requestId = nonEmptyString(record.requestId);
  if (hasRequestId && !requestId) {
    throw new Error("Restart signal requestId must be a non-empty string when present");
  }
  const hasReleaseCandidate = Object.hasOwn(record, "releaseCandidate");

  return createRestartSignal({
    validationMode: record.validationMode,
    requestId,
    requestedAt: nonEmptyString(record.requestedAt),
    source: nonEmptyString(record.source),
    releaseCandidate: hasReleaseCandidate
      ? parseReleaseCandidate(record.releaseCandidate)
      : undefined,
  });
}

export function readRestartSignalFile(signalFile: string): RestartSignal {
  return parseRestartSignalContent(readFileSync(signalFile, "utf-8"));
}

export function readCurrentRestartSignalFile(
  signalFile: string,
  inProgressSignalFile: string,
): RestartSignal | null {
  for (const filePath of [signalFile, inProgressSignalFile]) {
    try {
      return readRestartSignalFile(filePath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

/** What a tool tells its agent after asking for a restart. */
export const RESTART_WHEN_IDLE_NOTE =
  "The Bridge restarts on its own once every session and management job is idle, this session included. "
  + "Nothing is blocked until then: keep working normally, and do not wait for the restart or avoid tool calls.";

export interface RestartRequest {
  validationMode: RestartValidationMode;
  source: string;
  releaseCandidate?: RestartReleaseCandidate;
}

/** Join the pending restart; the serialized management runner publishes its newest release here. */
export async function requestRestart(dataDir: string, request: RestartRequest): Promise<RestartSignal> {
  const signalFile = join(dataDir, RESTART_SIGNAL_FILE_NAME);
  await mkdir(dataDir, { recursive: true });
  while (true) {
    const pending = await readPendingRestartSignal(dataDir);
    if (pending && !request.releaseCandidate) return pending;
    const signal = createRestartSignal({
      requestedAt: pending?.requestedAt,
      requestId: pending?.requestId ?? randomUUID(),
      validationMode: pending?.validationMode === "deploy" ? "deploy" : request.validationMode,
      source: request.source,
      releaseCandidate: request.releaseCandidate,
    });
    const tempFile = join(dataDir, `.${RESTART_SIGNAL_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempFile, serializeRestartSignal(signal), "utf8");
      if (request.releaseCandidate) {
        await rename(tempFile, signalFile);
      } else {
        // Create, never overwrite: an operational request racing a deploy must not erase its candidate.
        await link(tempFile, signalFile);
      }
      return signal;
    } catch (error) {
      if (request.releaseCandidate || !isErrnoException(error) || error.code !== "EEXIST") throw error;
    } finally {
      await rm(tempFile, { force: true });
    }
  }
}

/** Reads control files asynchronously: the launcher may be writing them while the server answers. */
export async function readPendingRestartSignal(dataDir: string): Promise<RestartSignal | null> {
  for (const name of [RESTART_SIGNAL_FILE_NAME, RESTART_IN_PROGRESS_FILE_NAME]) {
    try {
      return parseRestartSignalContent(await readFile(join(dataDir, name), "utf-8"));
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function recoverInvalidSignalIdentity(content: string): {
  requestId?: string;
  releaseCandidateId?: string;
} {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const requestId = nonEmptyString(record.requestId);
    const candidate = record.releaseCandidate;
    const releaseCandidateId = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? nonEmptyString((candidate as Record<string, unknown>).id)
        : undefined;
    return {
      ...(requestId ? { requestId } : {}),
      ...(releaseCandidateId ? { releaseCandidateId } : {}),
    };
  } catch {
    return {};
  }
}

export function consumeRestartSignalFile(
  signalFile: string,
  inProgressSignalFile: string,
): RestartSignalConsumption {
  let claimed = false;
  try {
    renameSync(signalFile, inProgressSignalFile);
    claimed = true;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      return { status: "retryable-error", stage: "claim", error };
    }
    try {
      statSync(signalFile);
      return { status: "retryable-error", stage: "claim", error };
    } catch (statError) {
      if (!isErrnoException(statError) || statError.code !== "ENOENT") {
        return { status: "retryable-error", stage: "claim", error: statError };
      }
    }
  }

  let content: string;
  try {
    content = readFileSync(inProgressSignalFile, "utf-8");
  } catch (error) {
    if (!claimed && isErrnoException(error) && error.code === "ENOENT") {
      return { status: "none" };
    }
    return { status: "retryable-error", stage: "read", error };
  }

  try {
    return { status: "claimed", signal: parseRestartSignalContent(content) };
  } catch (error) {
    return {
      status: "invalid",
      error: toError(error),
      ...recoverInvalidSignalIdentity(content),
    };
  }
}

export function writeRestartSignalFile(signalFile: string, options: {
  validationMode: RestartValidationMode;
  requestId?: string;
  source?: string;
  requestedAt?: string;
  releaseCandidate?: RestartReleaseCandidate;
}): void {
  const tempFile = join(dirname(signalFile), `.${basename(signalFile)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempFile, serializeRestartSignal(options), "utf8");
    renameSync(tempFile, signalFile);
  } catch (error) {
    try {
      rmSync(tempFile, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `Failed to publish restart signal (${toError(error).message}) and clean up ${tempFile}: `
        + toError(cleanupError).message,
        { cause: error },
      );
    }
    throw error;
  }
}
