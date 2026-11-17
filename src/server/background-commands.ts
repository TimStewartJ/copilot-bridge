// Runtime sends no notice for a command cut off by unload or crash; this tells the waiting agent.

import type { BackgroundCommandStore } from "./background-command-store.js";
import type { DeferredPromptRunner } from "./deferred-prompt-runner.js";
import { BACKGROUND_COMMAND_DELIVERY_ID_PREFIX, type DeferredPromptStore } from "./deferred-prompt-store.js";

/** 99% of finished commands end within this; the cap stops dev servers pinning sessions. */
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
  /** The operating system's ID for the process running the command, when the runtime gave one. */
  pid?: number;
}

/** unloaded: handle released, command stopped; runtime-lost/restart: process may still run. */
export type BackgroundCommandStopCause = "unloaded" | "runtime-lost" | "restart";

export interface StoppedBackgroundCommand extends RunningBackgroundCommand {
  stoppedAt: string;
  stoppedBy: BackgroundCommandStopCause;
}

/** Whether the command's process may have outlived the session that started it. */
export function mayStillBeRunning(command: Pick<StoppedBackgroundCommand, "stoppedBy">): boolean {
  return command.stoppedBy !== "unloaded";
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
  const text = command.command ? `: ${oneLine(command.command, COMMAND_PREVIEW_CHARS)}` : "";
  if (!mayStillBeRunning(command)) {
    return `- shellId ${command.shellId}${label} (started ${command.startedAt}, stopped when the Bridge unloaded this session)${text}`;
  }
  // The process ID is how the agent finds a command that outlived its session.
  const process = command.pid !== undefined ? ` as process ${command.pid}` : "";
  const cause = command.stoppedBy === "restart"
    ? "cut off when the Bridge restarted"
    : "cut off when the agent runtime was lost";
  return `- shellId ${command.shellId}${label} (started ${command.startedAt}${process}, ${cause}, possibly still running)${text}`;
}

/** Says "stopped" only when known; else the agent must look for the process before rerunning it. */
export function buildStoppedCommandsNotice(commands: readonly StoppedBackgroundCommand[]): string {
  const listed = commands.slice(0, MAX_LISTED_COMMANDS);
  const unlisted = commands.length - listed.length;
  const more = unlisted > 0 ? [`- and ${unlisted} more`] : [];
  if (!commands.some(mayStillBeRunning)) {
    return [
      "<bridge_notice>",
      "Background commands this session left running were stopped before they finished. Their shell IDs no longer exist and no completion notice will arrive.",
      ...listed.map(describeStoppedCommand),
      ...more,
      "A stopped command may have done part of its work. Rerun what the work still needs, and check a command's effects first where running it twice could do harm.",
      "</bridge_notice>",
    ].join("\n");
  }
  return [
    "<bridge_notice>",
    "This session lost track of background commands it left running. Their shell IDs no longer exist and no completion notice will arrive.",
    ...listed.map(describeStoppedCommand),
    ...more,
    "The Bridge does not know what became of a command marked possibly still running: it may be running now, or it may have finished or been stopped. Before you rerun it, look for its process, by the listed ID where there is one (confirm the start time, because an ID can be reused) and otherwise by its command line. If it is running, stop it or wait for it to exit.",
    "A command that was cut off may have done part or all of its work. Rerun what the work still needs, and check a command's effects first where running it twice could do harm.",
    "</bridge_notice>",
  ].join("\n");
}

/** The notice as its own message, for an agent that ended its turn to wait on the command. */
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
  /** A run of the session is in flight. Loading the session again (a reload) is not a run. */
  hasRunInFlight?(sessionId: string): boolean;
  isSessionArchived?(sessionId: string): boolean;
}

export type StoppedCommandWakeOutcome = "queued" | "none" | "not_recent" | "archived" | "busy" | "cooldown";

/** Wake only for commands in the protect window; older losses go out with the next message. */
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
  // A turn in flight carries the notice in its recovery prompt; only idle sessions are woken here.
  if (deps.hasRunInFlight?.(sessionId)) return "busy";
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

/** Call once per process before sessions load; wake only in production, never a staged preview. */
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
