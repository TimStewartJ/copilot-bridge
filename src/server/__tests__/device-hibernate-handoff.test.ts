import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestDeviceHibernate, type DeviceHibernateCommand } from "../platform.js";
import {
  armHibernateOnIdle,
  cancelHibernate,
  disarmHibernateOnIdle,
  getHibernateOnIdleStatus,
  getHibernateStatus,
  scheduleHibernate,
  HIBERNATE_IDLE_POLL_INTERVAL_MS,
} from "../device-hibernate.js";
import {
  HIBERNATE_HANDOFF_FILE_NAME,
  HIBERNATE_HANDOFF_MAX_AGE_MS,
  HIBERNATE_HANDOFF_SETTLE_MS,
  restoreHibernateHandoff,
  saveHibernateHandoff,
} from "../device-hibernate-handoff.js";
import { makeTestDir } from "./helpers.js";

vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  return {
    ...actual,
    requestDeviceHibernate: vi.fn(),
  };
});

const requestDeviceHibernateMock = vi.mocked(requestDeviceHibernate);
const command: DeviceHibernateCommand = { platform: "linux", command: "systemctl", args: ["hibernate"] };
const GRACE_MS = 2 * 60_000;
const TIMERS = ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;

let dataDir: string;
let activeSessions: number;

function sources() {
  return {
    sessionManager: { getLifecycleBlockingSessionCount: () => activeSessions },
    runtimePaths: { dataDir },
  };
}

function handoffFile(): string {
  return join(dataDir, HIBERNATE_HANDOFF_FILE_NAME);
}

/** The state a new server process starts with: nothing armed, nothing scheduled. */
function startNewServer(): void {
  cancelHibernate();
  disarmHibernateOnIdle();
}

function restore(options: { now?: number; bootTimeMs?: number } = {}) {
  return restoreHibernateHandoff(sources(), dataDir, { bootTimeMs: 0, getCommand: () => command, ...options });
}

function writeHandoff(file: unknown): void {
  writeFileSync(handoffFile(), typeof file === "string" ? file : JSON.stringify(file), "utf8");
}

beforeEach(() => {
  startNewServer();
  dataDir = makeTestDir("hibernate-handoff");
  activeSessions = 0;
  requestDeviceHibernateMock.mockReset();
  requestDeviceHibernateMock.mockResolvedValue(command);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  startNewServer();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hibernate handoff across a server restart", () => {
  it("writes nothing when no hibernation is pending", async () => {
    expect(await saveHibernateHandoff(dataDir)).toBe(false);
    expect(existsSync(handoffFile())).toBe(false);
    expect(await restore()).toEqual({ restored: false, reason: "none" });
  });

  it("re-arms the idle watcher in the next server and hibernates once sessions are idle", async () => {
    vi.useFakeTimers({ toFake: [...TIMERS], now: new Date("2026-06-06T00:00:00.000Z") });
    activeSessions = 1;
    armHibernateOnIdle({ command, graceMs: GRACE_MS, getActiveSessionCount: () => activeSessions });

    expect(await saveHibernateHandoff(dataDir)).toBe(true);
    expect(JSON.parse(readFileSync(handoffFile(), "utf8"))).toEqual({
      version: 1,
      writtenAt: Date.now(),
      onIdleGraceMs: GRACE_MS,
      scheduledAt: null,
    });
    // The old server still reports it, but no longer acts on it.
    expect(getHibernateOnIdleStatus().armed).toBe(true);
    activeSessions = 0;
    await vi.advanceTimersByTimeAsync(GRACE_MS + HIBERNATE_IDLE_POLL_INTERVAL_MS);
    expect(requestDeviceHibernateMock, "the server that is shutting down must not hibernate").not.toHaveBeenCalled();

    startNewServer();
    activeSessions = 1;
    expect(await restore()).toEqual({ restored: true, onIdleGraceMs: GRACE_MS, scheduledAt: null });
    expect(existsSync(handoffFile()), "the file is good for one start").toBe(false);
    expect(getHibernateOnIdleStatus()).toMatchObject({ armed: true, graceMs: GRACE_MS, activeSessions: 1 });

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(requestDeviceHibernateMock, "held while a session runs").not.toHaveBeenCalled();

    activeSessions = 0;
    await vi.advanceTimersByTimeAsync(GRACE_MS + HIBERNATE_IDLE_POLL_INTERVAL_MS);
    expect(requestDeviceHibernateMock).toHaveBeenCalledOnce();
    expect(requestDeviceHibernateMock).toHaveBeenCalledWith(command);
    expect(getHibernateOnIdleStatus().armed).toBe(false);

    expect(await restore(), "a second start finds nothing").toEqual({ restored: false, reason: "none" });
  });

  it("keeps a timed hibernation at its time", async () => {
    vi.useFakeTimers({ toFake: [...TIMERS], now: new Date("2026-06-06T00:00:00.000Z") });
    const { scheduledAt } = scheduleHibernate(command, 30 * 60_000);

    expect(await saveHibernateHandoff(dataDir)).toBe(true);
    expect(getHibernateStatus().pending).toBe(true);
    startNewServer();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await restore()).toEqual({ restored: true, onIdleGraceMs: null, scheduledAt });
    expect(getHibernateStatus()).toMatchObject({ pending: true, scheduledAt });

    await vi.advanceTimersByTimeAsync(30 * 60_000 - 10_000 - 1);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestDeviceHibernateMock).toHaveBeenCalledOnce();
  });

  it("a timed hibernation the restart overran waits for the new server to settle", async () => {
    vi.useFakeTimers({ toFake: [...TIMERS], now: new Date("2026-06-06T00:00:00.000Z") });
    scheduleHibernate(command, 5_000);
    await saveHibernateHandoff(dataDir);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestDeviceHibernateMock, "handed off: the old server does not fire it").not.toHaveBeenCalled();
    startNewServer();
    await vi.advanceTimersByTimeAsync(15_000);

    const restored = await restore();
    expect(restored).toEqual({
      restored: true,
      onIdleGraceMs: null,
      scheduledAt: Date.now() + HIBERNATE_HANDOFF_SETTLE_MS,
    });
    await vi.advanceTimersByTimeAsync(HIBERNATE_HANDOFF_SETTLE_MS);
    expect(requestDeviceHibernateMock).toHaveBeenCalledOnce();
  });

  it("gives an idle watcher without a grace window the settle time", async () => {
    const now = Date.now();
    writeHandoff({ version: 1, writtenAt: now, onIdleGraceMs: 0, scheduledAt: null });

    expect(await restore({ now })).toEqual({
      restored: true,
      onIdleGraceMs: HIBERNATE_HANDOFF_SETTLE_MS,
      scheduledAt: null,
    });
    expect(getHibernateOnIdleStatus()).toMatchObject({ armed: true, graceMs: HIBERNATE_HANDOFF_SETTLE_MS });
  });

  it("drops a handoff that is older than a restart takes", async () => {
    const now = Date.now();
    writeHandoff({
      version: 1,
      writtenAt: now - HIBERNATE_HANDOFF_MAX_AGE_MS - 1,
      onIdleGraceMs: GRACE_MS,
      scheduledAt: now + 60_000,
    });

    expect(await restore({ now })).toEqual({ restored: false, reason: "stale" });
    expect(getHibernateOnIdleStatus().armed).toBe(false);
    expect(getHibernateStatus().pending).toBe(false);
    expect(existsSync(handoffFile())).toBe(false);
  });

  it("drops a handoff written before the device last booted", async () => {
    const now = Date.now();
    writeHandoff({ version: 1, writtenAt: now - 120_000, onIdleGraceMs: GRACE_MS, scheduledAt: null });

    expect(await restore({ now, bootTimeMs: now - 60_000 })).toEqual({ restored: false, reason: "device-restarted" });
    expect(getHibernateOnIdleStatus().armed).toBe(false);
    expect(existsSync(handoffFile())).toBe(false);
  });

  it("takes a handoff over when the device booted before it was written", async () => {
    const now = Date.now();
    writeHandoff({ version: 1, writtenAt: now - 5_000, onIdleGraceMs: GRACE_MS, scheduledAt: null });

    expect(await restore({ now, bootTimeMs: now - 3_600_000 })).toMatchObject({ restored: true });
  });

  it.each([
    ["truncated JSON", "{\"version\":1,\"writtenAt\":"],
    ["another version", { version: 2, writtenAt: Date.now(), onIdleGraceMs: GRACE_MS, scheduledAt: null }],
    ["no writtenAt", { version: 1, onIdleGraceMs: GRACE_MS, scheduledAt: null }],
    ["nothing pending", { version: 1, writtenAt: Date.now(), onIdleGraceMs: null, scheduledAt: null }],
    ["a negative grace window", { version: 1, writtenAt: Date.now(), onIdleGraceMs: -1, scheduledAt: null }],
    ["an array", [1]],
  ])("leaves hibernation off when the file holds %s", async (_label, file) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeHandoff(file);

    expect(await restore()).toEqual({ restored: false, reason: "unreadable" });
    expect(errorSpy).toHaveBeenCalled();
    expect(getHibernateOnIdleStatus().armed).toBe(false);
    expect(getHibernateStatus().pending).toBe(false);
    expect(existsSync(handoffFile())).toBe(false);
  });

  it("leaves hibernation off on a platform that cannot hibernate", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.now();
    writeHandoff({ version: 1, writtenAt: now, onIdleGraceMs: GRACE_MS, scheduledAt: null });

    const result = await restoreHibernateHandoff(sources(), dataDir, {
      now,
      bootTimeMs: 0,
      getCommand: () => {
        throw new Error("Device hibernation is not supported on macOS by Copilot Bridge.");
      },
    });

    expect(result).toEqual({ restored: false, reason: "unsupported" });
    expect(errorSpy).toHaveBeenCalled();
    expect(getHibernateOnIdleStatus().armed).toBe(false);
  });
});
