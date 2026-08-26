import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createDeadline } from "./deadline.js";
import { captureProcessStartTimes } from "./platform.js";

const IN_USE_LOCK_PATTERN = /^inuse\.(\d+)\.lock$/;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 5_000;
const PROCESS_START_TOLERANCE_MS = 5_000;

export interface SessionLockObservation {
  sessionId: string;
  pid: number;
  createdAtMs: number;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function selectLiveExternalSessionIds(
  observations: readonly SessionLockObservation[],
  processStartTimes: ReadonlyMap<number, number>,
  backendPid: number,
): Set<string> {
  const inUse = new Set<string>();
  for (const observation of observations) {
    if (observation.pid === backendPid) continue;
    const processStartTimeMs = processStartTimes.get(observation.pid);
    if (processStartTimeMs === undefined) continue;
    if (processStartTimeMs <= observation.createdAtMs + PROCESS_START_TOLERANCE_MS) {
      inUse.add(observation.sessionId);
    }
  }
  return inUse;
}

async function readSessionLockObservations(
  copilotHome: string,
  sessionIds: readonly string[],
): Promise<SessionLockObservation[]> {
  const observations = await Promise.all(sessionIds.map(async (sessionId) => {
    const sessionDir = join(copilotHome, "session-state", sessionId);
    let entries;
    try {
      entries = await readdir(sessionDir, { withFileTypes: true });
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return [];
      throw error;
    }

    const locks = await Promise.all(entries.flatMap((entry) => {
      if (!entry.isFile()) return [];
      const match = entry.name.match(IN_USE_LOCK_PATTERN);
      if (!match) return [];
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return [];
      const lockPath = join(sessionDir, entry.name);
      return [stat(lockPath).then(
        (lockStat): SessionLockObservation => ({
          sessionId,
          pid,
          createdAtMs: lockStat.birthtimeMs > 0 ? lockStat.birthtimeMs : lockStat.mtimeMs,
        }),
        (error) => {
          if (getErrorCode(error) === "ENOENT") return undefined;
          throw error;
        },
      )];
    }));
    return locks.filter((lock): lock is SessionLockObservation => lock !== undefined);
  }));
  return observations.flat();
}

export async function validateExternalSessionUse(options: {
  copilotHome: string;
  candidateSessionIds: readonly string[];
  backendPid: number;
}): Promise<Set<string> | undefined> {
  const observations = await readSessionLockObservations(
    options.copilotHome,
    options.candidateSessionIds,
  );
  const externalObservations = observations.filter((observation) => observation.pid !== options.backendPid);
  if (externalObservations.length === 0) return new Set();

  const processStartTimes = await captureProcessStartTimes(
    [...new Set(externalObservations.map((observation) => observation.pid))],
    createDeadline(PROCESS_SNAPSHOT_TIMEOUT_MS),
  );
  if (!processStartTimes) return undefined;

  return selectLiveExternalSessionIds(
    externalObservations,
    processStartTimes,
    options.backendPid,
  );
}
