import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type RestartPhase = "idle" | "queued" | "waiting-for-sessions" | "restarting";

export type ReleaseFailureEvent =
  | "launcher-manual-intervention-required"
  | "launcher-retry-budget-exhausted";

export type ReleaseFailurePhase = "build" | "rollback" | "restart-health-check" | "shutdown";

export interface ReleaseFailureState {
  event: ReleaseFailureEvent;
  phase: ReleaseFailurePhase;
  failedAt: string | null;
  message: string | null;
  command: string | null;
  validationLogPath: string | null;
  commitSha: string | null;
  rollbackTarget: string | null;
}

export interface RestartState {
  requestId: string | null;
  phase: RestartPhase;
  requestedAt: string | null;
  waitingSessions: number;
  launcherHeartbeatAt: string | null;
  releaseFailure?: ReleaseFailureState | null;
}

const defaultRestartState = {
  requestId: null,
  phase: "idle",
  requestedAt: null,
  waitingSessions: 0,
  launcherHeartbeatAt: null,
  releaseFailure: null,
} satisfies RestartState;

export const DEFAULT_RESTART_STATE: Readonly<RestartState> = Object.freeze(defaultRestartState);
const TRANSIENT_RESTART_STATE_FS_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RESTART_STATE_FS_RETRY_DELAYS_MS = [25, 50, 100, 250, 500] as const;
const RESTART_STATE_RM_OPTIONS = { force: true } as const;

export function createDefaultRestartState(): RestartState {
  return { ...DEFAULT_RESTART_STATE };
}

function isRestartPhase(value: unknown): value is RestartPhase {
  return value === "idle"
    || value === "queued"
    || value === "waiting-for-sessions"
    || value === "restarting";
}

function coerceOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function coerceWaitingSessions(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function isReleaseFailureEvent(value: unknown): value is ReleaseFailureEvent {
  return value === "launcher-manual-intervention-required"
    || value === "launcher-retry-budget-exhausted";
}

function isReleaseFailurePhase(value: unknown): value is ReleaseFailurePhase {
  return value === "build"
    || value === "rollback"
    || value === "restart-health-check"
    || value === "shutdown";
}

function normalizeReleaseFailureState(value: unknown): ReleaseFailureState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isReleaseFailureEvent(record.event) || !isReleaseFailurePhase(record.phase)) {
    return null;
  }

  return {
    event: record.event,
    phase: record.phase,
    failedAt: coerceOptionalString(record.failedAt),
    message: coerceOptionalString(record.message),
    command: coerceOptionalString(record.command),
    validationLogPath: coerceOptionalString(record.validationLogPath),
    commitSha: coerceOptionalString(record.commitSha),
    rollbackTarget: coerceOptionalString(record.rollbackTarget),
  };
}

function normalizeRestartState(value: unknown): RestartState {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};

  return {
    requestId: coerceOptionalString(record.requestId),
    phase: isRestartPhase(record.phase) ? record.phase : DEFAULT_RESTART_STATE.phase,
    requestedAt: coerceOptionalString(record.requestedAt),
    waitingSessions: coerceWaitingSessions(record.waitingSessions),
    launcherHeartbeatAt: coerceOptionalString(record.launcherHeartbeatAt),
    releaseFailure: normalizeReleaseFailureState(record.releaseFailure),
  };
}

export function buildRestartStateWithReleaseFailure(
  state: RestartState,
  releaseFailure: ReleaseFailureState,
): RestartState {
  return {
    ...state,
    phase: "idle",
    waitingSessions: 0,
    releaseFailure: normalizeReleaseFailureState(releaseFailure),
  };
}

function getTempRestartStatePath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
}

function getFsErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isTransientRestartStateFsError(error: unknown): boolean {
  const code = getFsErrorCode(error);
  return code !== undefined && TRANSIENT_RESTART_STATE_FS_ERROR_CODES.has(code);
}

type RestartStateFsRetrySleep = (ms: number) => Promise<void>;

// Capture the real timer at module load. Callers may install fake timers after
// importing this module (e.g. test suites), but the transient-FS retry backoff
// must still elapse in real time — freezing it under fake timers would hang any
// real restart-state file I/O. Binding here keeps that backoff immune to a
// later fake-timer installation while remaining identical in production.
const realSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout;

const defaultRestartStateFsRetrySleep: RestartStateFsRetrySleep = (ms) =>
  new Promise((resolve) => realSetTimeout(resolve, ms));

let restartStateFsRetrySleep: RestartStateFsRetrySleep = defaultRestartStateFsRetrySleep;

/**
 * Test seam for the transient-FS-retry backoff sleep. The default is already
 * bound to the real timer (see above), so most suites need no override; this
 * exists for tests that want to make the backoff instant or deterministic. Pass
 * undefined to restore the default. Not for production use.
 */
export function __setRestartStateFsRetrySleepForTests(sleep?: RestartStateFsRetrySleep): void {
  restartStateFsRetrySleep = sleep ?? defaultRestartStateFsRetrySleep;
}

async function retryTransientRestartStateFsOperation<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= RESTART_STATE_FS_RETRY_DELAYS_MS.length
        || !isTransientRestartStateFsError(error)
      ) {
        throw error;
      }
      await restartStateFsRetrySleep(RESTART_STATE_FS_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function readRestartState(filePath: string): Promise<RestartState> {
  try {
    const raw = await retryTransientRestartStateFsOperation(() => readFile(filePath, "utf8"));
    if (!raw.trim()) return createDefaultRestartState();
    return normalizeRestartState(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultRestartState();
  }
}

export function readRestartStateSync(filePath: string): RestartState {
  try {
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) return createDefaultRestartState();
    return normalizeRestartState(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultRestartState();
  }
}

export async function writeRestartState(filePath: string, state: RestartState): Promise<RestartState> {
  const normalized = normalizeRestartState(state);
  const tempPath = getTempRestartStatePath(filePath);

  await retryTransientRestartStateFsOperation(() => mkdir(dirname(filePath), { recursive: true }));
  try {
    await retryTransientRestartStateFsOperation(
      () => writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8"),
    );
    await retryTransientRestartStateFsOperation(() => rename(tempPath, filePath));
  } catch (error) {
    await retryTransientRestartStateFsOperation(
      () => rm(tempPath, RESTART_STATE_RM_OPTIONS),
    ).catch(() => undefined);
    throw error;
  }

  return normalized;
}

export async function clearRestartState(filePath: string): Promise<void> {
  await retryTransientRestartStateFsOperation(() => rm(filePath, RESTART_STATE_RM_OPTIONS));
}
