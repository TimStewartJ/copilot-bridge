// Commands an agent left running in a session's attached shell: what the Bridge keeps loaded for
// them, and how it tells the agent when it had to stop one.
//
// The runtime runs these commands inside the session's handle. Releasing the handle (idle
// eviction, a configuration refresh, a restart) stops them, and the runtime sends no completion
// notice for a command it did not see finish. Without the pieces here, the agent that ended its
// turn to wait for the command would never hear about it again.

import type { BackgroundCommandStore } from "./background-command-store.js";
import type { DeferredPromptRunner } from "./deferred-prompt-runner.js";
import { BACKGROUND_COMMAND_DELIVERY_ID_PREFIX, type DeferredPromptStore } from "./deferred-prompt-store.js";

/**
 * How long after a background command starts the Bridge keeps its session loaded and holds its
 * own restarts for it. Of the background commands that finished in a month of sessions, 99% did
 * so within this window. The limit exists because some never finish: a dev server or a watcher
 * must not pin a session or hold restarts for as long as it runs.
 */
export const BACKGROUND_COMMAND_PROTECT_MS = 45 * 60_000;

/** Matches the other automatic resumes, so a command that takes the server down cannot loop. */
export const BACKGROUND_COMMAND_WAKE_COOLDOWN_MS = 10 * 60_000;

const COMMAND_PREVIEW_CHARS = 200;
const DESCRIPTION_PREVIEW_CHARS = 120;
const MAX_LISTED_COMMANDS = 10;

export interface RunningBackgroundCommand {
  shellId: string;
  /** ISO time the runtime started the command, or when the Bridge first saw it. */
  startedAt: string;
  description?: string;
  command?: string;
}

/** `restart`: the server stopped. `unloaded`: the Bridge released the session's runtime handle. */
export type BackgroundCommandStopCause = "restart" | "unloaded";

export interface StoppedBackgroundCommand extends RunningBackgroundCommand {
  stoppedAt: string;
  stoppedBy: BackgroundCommandStopCause;
}

/** Whether the command was started recently enough for the Bridge to keep its session for it. */
export function isWithinBackgroundCommandProtection(
  startedAt: string | undefined,
  now: number,
  protectMs = BACKGROUND_COMMAND_PROTECT_MS,
): boolean {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(startedAtMs) && now - startedAtMs <= protectMs;
}

function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim().replaceAll("</bridge_notice", "<\\/bridge_notice");
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

function describeStoppedCommand(command: StoppedBackgroundCommand): string {
  const label = command.description ? ` "${oneLine(command.description, DESCRIPTION_PREVIEW_CHARS)}"` : "";
  const cause = command.stoppedBy === "restart"
    ? "stopped when the Bridge restarted"
    : "stopped when the Bridge unloaded this session";
  const text = command.command ? `: ${oneLine(command.command, COMMAND_PREVIEW_CHARS)}` : "";
  return `- shellId ${command.shellId}${label} (started ${command.startedAt}, ${cause})${text}`;
}

/** The notice an agent gets, once, about commands the Bridge stopped under it. */
export function buildStoppedCommandsNotice(commands: readonly StoppedBackgroundCommand[]): string {
  const listed = commands.slice(0, MAX_LISTED_COMMANDS);
  const unlisted = commands.length - listed.length;
  return [
    "<bridge_notice>",
    "Background commands this session left running were stopped before they finished. Their shell IDs no longer exist and no completion notice will arrive.",
    ...listed.map(describeStoppedCommand),
    ...(unlisted > 0 ? [`- and ${unlisted} more`] : []),
    "A stopped command may have done part of its work. Rerun what the work still needs, and check a command's effects first where running it twice could do harm.",
    "</bridge_notice>",
  ].join("\n");
}

/** The same notice as a message of its own, for an agent that ended its turn to wait for the command. */
export function buildStoppedCommandsWakePrompt(commands: readonly StoppedBackgroundCommand[]): string {
  return [
    buildStoppedCommandsNotice(commands),
    "",
    "Continue the work that was waiting on these commands. If nothing still needs them, say so in one line and stop.",
  ].join("\n");
}

export interface StoppedCommandWakeDeps {
  backgroundCommandStore: Pick<BackgroundCommandStore, "listStopped" | "clearStopped">;
  deferredPromptStore: Pick<DeferredPromptStore, "enqueueDelivery" | "listDeliveriesForSession">;
  deferredPromptRunner?: Pick<DeferredPromptRunner, "poke">;
  isSessionBusy?(sessionId: string): boolean;
  isSessionArchived?(sessionId: string): boolean;
}

export type StoppedCommandWakeOutcome = "queued" | "none" | "not_recent" | "archived" | "busy" | "cooldown";

/**
 * Starts a turn that tells an idle agent its commands were stopped. Only for a command the Bridge
 * was still keeping the session for: that one was cut off by something the agent could not expect
 * (a forced restart, a crash, a configuration refresh), and the agent is most likely waiting for
 * it. An older command is usually a server nobody is waiting for, so its loss stays with the store
 * and goes out with the session's next message instead. A queued wake takes the session's stopped
 * commands with it, so the next message does not repeat them.
 */
export function queueStoppedCommandWake(
  deps: StoppedCommandWakeDeps,
  sessionId: string,
  now: Date = new Date(),
): StoppedCommandWakeOutcome {
  const stopped = deps.backgroundCommandStore.listStopped(sessionId);
  if (stopped.length === 0) return "none";
  const recent = stopped.some((command) =>
    isWithinBackgroundCommandProtection(command.startedAt, Date.parse(command.stoppedAt)));
  if (!recent) return "not_recent";
  if (deps.isSessionArchived?.(sessionId)) return "archived";
  // A turn in flight is retried or resumed by its own recovery, and that prompt carries the notice.
  if (deps.isSessionBusy?.(sessionId)) return "busy";
  const sourceId = `${BACKGROUND_COMMAND_DELIVERY_ID_PREFIX}${sessionId}`;
  const lastWakeAt = deps.deferredPromptStore.listDeliveriesForSession(sessionId)
    .filter((delivery) => delivery.sourceId === sourceId)
    .map((delivery) => Date.parse(delivery.createdAt))
    .filter(Number.isFinite)
    .reduce((latest, createdAt) => Math.max(latest, createdAt), Number.NEGATIVE_INFINITY);
  if (now.getTime() - lastWakeAt < BACKGROUND_COMMAND_WAKE_COOLDOWN_MS) return "cooldown";

  deps.deferredPromptStore.enqueueDelivery({
    id: `${sourceId}:${now.getTime()}`,
    sessionId,
    sourceId,
    prompt: buildStoppedCommandsWakePrompt(stopped),
  }, now.toISOString());
  deps.backgroundCommandStore.clearStopped(sessionId, stopped);
  deps.deferredPromptRunner?.poke();
  return "queued";
}

export interface BackgroundCommandBootRecovery {
  /** Commands that were still running when the previous server stopped. */
  stopped: number;
  /** Sessions sent a message of their own about it. */
  woken: string[];
}

/**
 * A command still marked running at boot was cut off by the server stopping: a loaded session
 * clears the mark when its command finishes. Call once per process, before any session loads.
 * `wake` is for the production server only. A staged preview must never start turns on its own.
 */
export function recoverBackgroundCommandsOnBoot(
  deps: Omit<StoppedCommandWakeDeps, "backgroundCommandStore" | "deferredPromptStore"> & {
    backgroundCommandStore: BackgroundCommandStore;
    deferredPromptStore?: StoppedCommandWakeDeps["deferredPromptStore"];
  },
  options: { wake: boolean; alreadyResumedSessionIds?: readonly string[]; now?: Date },
): BackgroundCommandBootRecovery {
  const now = options.now ?? new Date();
  const stopped = deps.backgroundCommandStore.markAllRunningStopped("restart", now);
  deps.backgroundCommandStore.pruneStopped(now);
  const result: BackgroundCommandBootRecovery = { stopped: stopped.length, woken: [] };
  const deferredPromptStore = deps.deferredPromptStore;
  if (!options.wake || !deferredPromptStore) return result;
  // A run the restart cut off is resumed with its own prompt, which carries the notice.
  const alreadyResumed = new Set(options.alreadyResumedSessionIds ?? []);
  for (const sessionId of new Set(stopped.map((command) => command.sessionId))) {
    if (alreadyResumed.has(sessionId)) continue;
    if (queueStoppedCommandWake({ ...deps, deferredPromptStore }, sessionId, now) === "queued") {
      result.woken.push(sessionId);
    }
  }
  return result;
}
