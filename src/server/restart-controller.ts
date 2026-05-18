import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import * as globalBus from "./global-bus.js";
import {
  clearRestartState,
  createDefaultRestartState,
  readRestartState,
  readRestartStateSync,
  writeRestartState,
  type RestartPhase,
  type RestartState,
} from "./restart-state.js";
import type { GlobalBus } from "./global-bus.js";
import type { RuntimePaths } from "./runtime-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));
const DEFAULT_RESTART_STATE_PATH = join(REPO_ROOT, "data", "restart-state.json");

let _restartStatePath = DEFAULT_RESTART_STATE_PATH;
let _restartStateStoreGeneration = 0;
let _restartState = createDefaultRestartState();
let _restartStateWriteQueue: Promise<void> = Promise.resolve();
let _restartEventBus: GlobalBus = globalBus.defaultGlobalBus;
let _activeSessionCountProvider: () => number = () => 0;

export const RESTART_PENDING_MESSAGE = "Restart pending — wait for reconnect.";
export const PROMPT_DELIVERY_ABORTED_MESSAGE = "Session was aborted before the prompt was accepted";
export const PROMPT_DELIVERY_SHUTDOWN_MESSAGE = "Session shut down before the prompt was accepted";

function resolveRestartStatePath(runtimePaths?: RuntimePaths): string {
  return join(runtimePaths?.dataDir ?? join(REPO_ROOT, "data"), "restart-state.json");
}

type RestartStateWriteTarget = {
  path: string;
  generation: number;
};

function captureRestartStateWriteTarget(): RestartStateWriteTarget {
  return {
    path: _restartStatePath,
    generation: _restartStateStoreGeneration,
  };
}

function isCurrentRestartStateWriteTarget(target: RestartStateWriteTarget): boolean {
  return target.path === _restartStatePath && target.generation === _restartStateStoreGeneration;
}

function queueRestartStateWrite(write: () => Promise<void>): void {
  _restartStateWriteQueue = _restartStateWriteQueue
    .catch(() => undefined)
    .then(write)
    .catch((error) => {
      console.error("[restart] Failed to persist restart state:", error);
    });
}

function setCachedRestartState(state: RestartState): RestartState {
  _restartState = state;
  return state;
}

function shouldPreserveServerOwnedRestartState(persisted: RestartState): boolean {
  return isRestartActive(_restartState)
    && _restartState.requestId !== null
    && persisted.requestId === _restartState.requestId
    && persisted.phase !== "idle"
    && !hasLauncherTakenRestartOwnership(persisted);
}

function shouldPreserveLauncherOwnedLiveWaitingCount(persisted: RestartState): boolean {
  return isRestartActive(_restartState)
    && _restartState.requestId !== null
    && persisted.requestId === _restartState.requestId
    && hasLauncherTakenRestartOwnership(_restartState)
    && hasLauncherTakenRestartOwnership(persisted)
    && persisted.phase === _restartState.phase
    && persisted.launcherHeartbeatAt === _restartState.launcherHeartbeatAt;
}

function mergeLiveWaitingCount(persisted: RestartState): RestartState {
  return shouldPreserveLauncherOwnedLiveWaitingCount(persisted)
    ? { ...persisted, waitingSessions: _restartState.waitingSessions }
    : persisted;
}

function hasLauncherTakenRestartOwnership(state: RestartState): boolean {
  return state.launcherHeartbeatAt !== null || state.phase === "restarting";
}

function isRestartActive(state: RestartState): boolean {
  return state.phase !== "idle";
}

function getRestartPhaseForWaitingSessions(phase: RestartPhase, waitingSessions: number): RestartPhase {
  if (phase === "restarting") return "restarting";
  return waitingSessions > 0 ? "waiting-for-sessions" : "queued";
}

export function configureRestartActiveSessionCountProvider(provider?: () => number): void {
  _activeSessionCountProvider = provider ?? (() => 0);
}

export function configureRestartStateStore(runtimePaths?: RuntimePaths): void {
  const nextPath = resolveRestartStatePath(runtimePaths);
  if (_restartStatePath === nextPath) return;
  _restartStatePath = nextPath;
  _restartStateStoreGeneration += 1;
  _restartState = createDefaultRestartState();
  // Detach from writes already queued for the previous path. Their captured
  // targets keep the file path stable, and the generation guard protects this cache.
  _restartStateWriteQueue = Promise.resolve();
}

export function configureRestartEventBus(bus?: GlobalBus): void {
  _restartEventBus = bus ?? globalBus.defaultGlobalBus;
}

function emitRestartEvent(event: Parameters<GlobalBus["emit"]>[0]): void {
  _restartEventBus.emit(event);
  if (_restartEventBus !== globalBus.defaultGlobalBus) {
    globalBus.defaultGlobalBus.emit(event);
  }
}

export async function refreshRestartState(): Promise<RestartState> {
  await _restartStateWriteQueue;
  const persisted = await readRestartState(_restartStatePath);
  if (shouldPreserveServerOwnedRestartState(persisted)) {
    return _restartState;
  }
  return setCachedRestartState(mergeLiveWaitingCount(persisted));
}

export function refreshRestartStateSync(): RestartState {
  const persisted = readRestartStateSync(_restartStatePath);
  if (shouldPreserveServerOwnedRestartState(persisted)) {
    return _restartState;
  }
  if (
    isRestartActive(_restartState)
    && !hasLauncherTakenRestartOwnership(_restartState)
    && persisted.phase === "idle"
  ) {
    return _restartState;
  }
  return setCachedRestartState(mergeLiveWaitingCount(persisted));
}

export function isRestartPending(): boolean {
  return isRestartActive(_restartState);
}

export function isRestartCutoverInProgress(state: RestartState = _restartState): boolean {
  // Waiting phases keep the current server available; only the actual restart
  // phase should reject new work.
  return state.phase === "restarting";
}

export function clearRestartPending(): void {
  const wasPending = isRestartActive(_restartState);
  const writeTarget = captureRestartStateWriteTarget();
  setCachedRestartState(createDefaultRestartState());
  queueRestartStateWrite(async () => {
    await clearRestartState(writeTarget.path);
  });
  if (wasPending) {
    emitRestartEvent({ type: "server:restart-cleared" });
  }
}

export function getRestartWaitingCount(): number {
  return _restartState.waitingSessions;
}

/** Restart is imminent — pending AND no active sessions blocking it. */
export function isRestartImminent(): boolean {
  return isRestartPending() && getRestartWaitingCount() === 0;
}

export function isRestartPendingError(err: unknown): boolean {
  return err instanceof Error && err.message === RESTART_PENDING_MESSAGE;
}

export function isPromptDeliveryInterruptedError(err: unknown): boolean {
  return err instanceof Error && (
    err.message === PROMPT_DELIVERY_ABORTED_MESSAGE ||
    err.message === PROMPT_DELIVERY_SHUTDOWN_MESSAGE
  );
}

/**
 * Shared logic for both self_restart and staging_deploy.
 * Sets restart-pending state and emits the SSE event.
 * Returns the waiting-session count (excludes the calling session).
 */
export function triggerRestartPending(): number {
  // The calling session is still counted as active; subtract 1 since it will
  // finish momentarily and should not count as "blocking" the restart.
  const waitingCount = Math.max(0, _activeSessionCountProvider() - 1);
  const writeTarget = captureRestartStateWriteTarget();
  const nextState: RestartState = setCachedRestartState({
    requestId: randomUUID(),
    phase: getRestartPhaseForWaitingSessions("queued", waitingCount),
    requestedAt: new Date().toISOString(),
    waitingSessions: waitingCount,
    launcherHeartbeatAt: null,
  });
  queueRestartStateWrite(async () => {
    const persistedState = await writeRestartState(writeTarget.path, nextState);
    if (isCurrentRestartStateWriteTarget(writeTarget)) {
      setCachedRestartState(persistedState);
    }
  });
  emitRestartEvent({ type: "server:restart-pending", waitingSessions: nextState.waitingSessions });
  return waitingCount;
}

export function syncRestartWaitingSessions(waitingSessions: number): void {
  if (!isRestartActive(_restartState)) return;
  if (hasLauncherTakenRestartOwnership(_restartState)) {
    if (waitingSessions === _restartState.waitingSessions) return;
    setCachedRestartState({
      ..._restartState,
      waitingSessions,
    });
    emitRestartEvent({ type: "server:restart-pending", waitingSessions });
    return;
  }
  const nextPhase = getRestartPhaseForWaitingSessions(_restartState.phase, waitingSessions);
  if (
    nextPhase === _restartState.phase
    && waitingSessions === _restartState.waitingSessions
  ) {
    return;
  }
  // Snapshot server-owned fields. The launcher may update launcherHeartbeatAt,
  // phase, and requestId on disk between now and when the write queue fires.
  const nextState: RestartState = {
    ..._restartState,
    phase: nextPhase,
    waitingSessions,
  };
  setCachedRestartState(nextState);
  // The persisted restart-state file is only used to publish the initial restart
  // request. After that, waiting-session countdown stays in memory/SSE so the
  // launcher is the sole writer once it picks up the request.
  emitRestartEvent({ type: "server:restart-pending", waitingSessions: nextState.waitingSessions });
}
