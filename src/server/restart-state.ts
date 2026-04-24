import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type RestartPhase = "idle" | "queued" | "waiting-for-sessions" | "restarting";

export interface RestartState {
  requestId: string | null;
  phase: RestartPhase;
  requestedAt: string | null;
  waitingSessions: number;
  launcherHeartbeatAt: string | null;
}

const defaultRestartState = {
  requestId: null,
  phase: "idle",
  requestedAt: null,
  waitingSessions: 0,
  launcherHeartbeatAt: null,
} satisfies RestartState;

export const DEFAULT_RESTART_STATE: Readonly<RestartState> = Object.freeze(defaultRestartState);

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
  };
}

function getTempRestartStatePath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
}

export async function readRestartState(filePath: string): Promise<RestartState> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return createDefaultRestartState();
    return normalizeRestartState(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultRestartState();
  }
}

export async function writeRestartState(filePath: string, state: RestartState): Promise<RestartState> {
  const normalized = normalizeRestartState(state);
  const tempPath = getTempRestartStatePath(filePath);

  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return normalized;
}

export async function clearRestartState(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
