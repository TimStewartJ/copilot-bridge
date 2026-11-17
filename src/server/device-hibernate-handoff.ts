// Saves a pending hibernation for the next server; rewritten each minute so age = server downtime.

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { join } from "node:path";
import {
  armHibernateOnIdleForServer,
  getHibernateIntent,
  handOffHibernateIntent,
  scheduleHibernate,
  setHibernateIntentListener,
  type HibernateIdleSources,
  type HibernateIntent,
} from "./device-hibernate.js";
import { getDeviceHibernateCommand, type DeviceHibernateCommand } from "./platform.js";

export const HIBERNATE_HANDOFF_FILE_NAME = "hibernate-handoff.json";

/** Restarts take seconds, rollbacks minutes; older means the server was stopped on purpose. */
export const HIBERNATE_HANDOFF_MAX_AGE_MS = 10 * 60_000;

/** How often the running server rewrites the saved copy while a hibernation is pending. */
export const HIBERNATE_HANDOFF_REFRESH_MS = 60_000;

/** Minimum uptime before an inherited hibernation fires; queued results start runs meanwhile. */
export const HIBERNATE_HANDOFF_SETTLE_MS = 60_000;

const HANDOFF_VERSION = 1;

type HibernateHandoffFile = HibernateIntent & { version: number; writtenAt: number };

export type HibernateHandoffRestore =
  | { restored: false; reason: "none" | "unreadable" | "stale" | "device-restarted" | "unsupported" }
  | { restored: true; onIdleGraceMs: number | null; scheduledAt: number | null };

function handoffPath(dataDir: string): string {
  return join(dataDir, HIBERNATE_HANDOFF_FILE_NAME);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function writeHandoffFile(dataDir: string, intent: HibernateIntent): Promise<void> {
  const file: HibernateHandoffFile = { version: HANDOFF_VERSION, writtenAt: Date.now(), ...intent };
  // Temp file first so a kill midway leaves no parsable file; one writer, so a fixed name is safe.
  const tempPath = join(dataDir, `.${HIBERNATE_HANDOFF_FILE_NAME}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(file)}\n`, "utf8");
    await rename(tempPath, handoffPath(dataDir));
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface HibernateHandoffKeeper {
  /** Resolves once the saved copy matches the pending hibernation, or the attempt failed. */
  settled(): Promise<void>;
  /** Stops keeping the copy and leaves the file as it is. */
  stop(): Promise<void>;
}

let activeKeeper: HibernateHandoffKeeper | null = null;

/** Mirrors pending hibernation to disk; start after restoreHibernateHandoff, which deletes it. */
export function startHibernateHandoffKeeper(dataDir: string): HibernateHandoffKeeper {
  let stopped = false;
  let queued = false;
  let failing = false;
  // Unknown until the first pass: a file from a server that died may be there with nothing pending.
  let fileMayExist = true;
  let queue: Promise<void> = Promise.resolve();

  const syncOnce = async (): Promise<void> => {
    queued = false;
    if (stopped) return;
    const intent = getHibernateIntent();
    try {
      if (intent) {
        fileMayExist = true;
        await writeHandoffFile(dataDir, intent);
      } else if (fileMayExist) {
        await rm(handoffPath(dataDir), { force: true });
        fileMayExist = false;
      }
      failing = false;
    } catch (error) {
      // Said once per run of failures; the next pass tries again.
      if (!failing) {
        console.error(
          intent
            ? "[device] Could not save the pending hibernation; a server that dies now would lose it:"
            : "[device] Could not remove the saved hibernation:",
          error,
        );
      }
      failing = true;
    }
  };
  const sync = (): Promise<void> => {
    if (!queued && !stopped) {
      queued = true;
      queue = queue.then(syncOnce);
    }
    return queue;
  };

  const interval = setInterval(() => {
    if (getHibernateIntent() || failing) void sync();
  }, HIBERNATE_HANDOFF_REFRESH_MS);
  interval.unref?.();

  const keeper: HibernateHandoffKeeper = {
    settled: () => queue,
    stop: async () => {
      if (stopped) return queue;
      stopped = true;
      clearInterval(interval);
      if (activeKeeper === keeper) {
        activeKeeper = null;
        setHibernateIntentListener(null);
      }
      await queue;
    },
  };
  activeKeeper = keeper;
  setHibernateIntentListener(() => void sync());
  void sync();
  return keeper;
}

/** Stops the keeper `startHibernateHandoffKeeper` started, if one is running. */
export async function stopHibernateHandoffKeeper(): Promise<void> {
  await activeKeeper?.stop();
}

/** On shutdown, saves the pending hibernation for the next server and stops this one firing it. */
export async function saveHibernateHandoff(dataDir: string): Promise<boolean> {
  // From here on the file belongs to the next server, which removes it when it has read it.
  await stopHibernateHandoffKeeper();
  const intent = handOffHibernateIntent();
  if (!intent) {
    await rm(handoffPath(dataDir), { force: true }).catch(() => undefined);
    return false;
  }
  await writeHandoffFile(dataDir, intent);
  console.log("[device] Pending hibernation saved for the next server start");
  return true;
}

/** At startup, adopts a fresh handoff unless the device restarted; always removes the file. */
export async function restoreHibernateHandoff(
  sources: HibernateIdleSources,
  dataDir: string,
  options: {
    now?: number;
    /** When the device last booted. Defaults to the operating system's uptime. */
    bootTimeMs?: number;
    getCommand?: () => DeviceHibernateCommand;
  } = {},
): Promise<HibernateHandoffRestore> {
  const filePath = handoffPath(dataDir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { restored: false, reason: "none" };
    console.error("[device] Could not read the saved hibernation; leaving it off:", error);
    await rm(filePath, { force: true }).catch(() => undefined);
    return { restored: false, reason: "unreadable" };
  }
  await rm(filePath, { force: true }).catch((error) => {
    console.error("[device] Could not remove the saved hibernation file:", error);
  });

  let parsed: Partial<HibernateHandoffFile>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Partial<HibernateHandoffFile>;
  } catch (error) {
    console.error("[device] The saved hibernation could not be parsed; leaving it off:", error);
    return { restored: false, reason: "unreadable" };
  }
  const writtenAt = finiteOrNull(parsed.writtenAt);
  const savedGraceMs = finiteOrNull(parsed.onIdleGraceMs);
  const savedScheduledAt = finiteOrNull(parsed.scheduledAt);
  if (
    parsed.version !== HANDOFF_VERSION
    || writtenAt === null
    || (savedGraceMs === null && savedScheduledAt === null)
    || (savedGraceMs !== null && savedGraceMs < 0)
  ) {
    console.error("[device] The saved hibernation has an unknown shape; leaving it off");
    return { restored: false, reason: "unreadable" };
  }

  const now = options.now ?? Date.now();
  const ageMs = now - writtenAt;
  if (ageMs < 0 || ageMs > HIBERNATE_HANDOFF_MAX_AGE_MS) {
    console.log(`[device] Pending hibernation from the previous server not taken over: saved ${Math.round(ageMs / 1000)}s ago`);
    return { restored: false, reason: "stale" };
  }
  const bootTimeMs = options.bootTimeMs ?? now - uptime() * 1000;
  if (bootTimeMs > writtenAt) {
    console.log("[device] Pending hibernation from the previous server not taken over: the device has restarted since");
    return { restored: false, reason: "device-restarted" };
  }

  let command: DeviceHibernateCommand;
  try {
    command = (options.getCommand ?? getDeviceHibernateCommand)();
  } catch (error) {
    console.error("[device] Pending hibernation from the previous server not taken over:", error);
    return { restored: false, reason: "unsupported" };
  }

  let scheduledAt: number | null = null;
  if (savedScheduledAt !== null) {
    const delayMs = Math.max(savedScheduledAt - now, HIBERNATE_HANDOFF_SETTLE_MS);
    scheduledAt = scheduleHibernate(command, delayMs).scheduledAt;
    console.log(`[device] Scheduled hibernation taken over from the previous server (in ${Math.round(delayMs / 1000)}s)`);
  }
  let onIdleGraceMs: number | null = null;
  if (savedGraceMs !== null) {
    onIdleGraceMs = Math.max(savedGraceMs, HIBERNATE_HANDOFF_SETTLE_MS);
    const status = armHibernateOnIdleForServer(sources, command, onIdleGraceMs);
    console.log(
      `[device] Hibernate-on-idle taken over from the previous server (grace=${Math.round(onIdleGraceMs / 1000)}s, active=${status.activeSessions})`,
    );
  }
  return { restored: true, onIdleGraceMs, scheduledAt };
}
