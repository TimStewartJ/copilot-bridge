import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const RESTART_STATE_FILE_NAME = "restart-state.json";
export const RESTART_SIGNAL_FILE_NAME = "restart.signal";
export const RESTART_IN_PROGRESS_FILE_NAME = "restart-in-progress.json";

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

const DEFAULT_STALE_TEMP_MAX_AGE_MS = 60_000;

function isStaleRestartStateTempName(stateFileName: string, candidate: string): boolean {
  // Matches the layout produced by getTempRestartStatePath:
  // `.${basename(stateFile)}.${uuid}.tmp`
  return candidate.startsWith(`.${stateFileName}.`) && candidate.endsWith(".tmp");
}

/**
 * Best-effort sweep of orphaned restart-state temp files. The atomic
 * write-then-rename in writeRestartState leaves a `.restart-state.json.<uuid>.tmp`
 * behind if the process is force-killed between the write and the rename — which
 * is exactly what the launcher does to children during a restart cutover. Those
 * temps are never reclaimed otherwise and accumulate unbounded over time.
 *
 * Only temps older than maxAgeMs are removed so a concurrent writer's in-flight
 * temp (which lives for milliseconds) is never deleted. Returns the count
 * removed. All filesystem errors are swallowed — this is opportunistic cleanup.
 */
export function sweepStaleRestartStateTempFiles(
  stateFilePath: string,
  options: { maxAgeMs?: number } = {},
): number {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_TEMP_MAX_AGE_MS;
  const dir = dirname(stateFilePath);
  const stateFileName = basename(stateFilePath);
  const now = Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!isStaleRestartStateTempName(stateFileName, entry)) continue;
    const fullPath = join(dir, entry);
    try {
      if (now - statSync(fullPath).mtimeMs < maxAgeMs) continue;
      rmSync(fullPath, RESTART_STATE_RM_OPTIONS);
      removed++;
    } catch {
      // Another process may have renamed/removed it concurrently — ignore.
    }
  }
  return removed;
}

/**
 * Authoritative, cross-process check for whether a restart is already queued or
 * in flight, derived entirely from on-disk state in dataDir rather than any
 * process-local in-memory cache. The management-job-runner mutates its own
 * in-memory restart state via triggerRestartPending() during a deploy but is not
 * the process that gets restarted, so trusting its in-memory isRestartPending()
 * leaves it permanently "pending" and deadlocks future deploys. Reading disk
 * truth here keeps the deploy/update gate self-healing across cutovers.
 */
export function isRestartAlreadyInFlight(dataDir: string): boolean {
  if (existsSync(join(dataDir, RESTART_SIGNAL_FILE_NAME))) return true;
  if (existsSync(join(dataDir, RESTART_IN_PROGRESS_FILE_NAME))) return true;
  return readRestartStateSync(join(dataDir, RESTART_STATE_FILE_NAME)).phase !== "idle";
}
