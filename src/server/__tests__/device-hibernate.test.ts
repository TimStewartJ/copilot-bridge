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

vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  return {
    ...actual,
    requestDeviceHibernate: vi.fn(),
  };
});

const requestDeviceHibernateMock = vi.mocked(requestDeviceHibernate);
const command: DeviceHibernateCommand = { platform: "linux", command: "systemctl", args: ["hibernate"] };

beforeEach(() => {
  cancelHibernate();
  disarmHibernateOnIdle();
  requestDeviceHibernateMock.mockReset();
  requestDeviceHibernateMock.mockResolvedValue(command);
  vi.useFakeTimers({ now: new Date("2026-06-06T00:00:00.000Z") });
});

afterEach(() => {
  cancelHibernate();
  disarmHibernateOnIdle();
  vi.useRealTimers();
});

describe("device-hibernate scheduler", () => {
  it("reports no pending hibernation initially", () => {
    expect(getHibernateStatus()).toEqual({ pending: false, scheduledAt: null, delayMs: null });
  });

  it("schedules, exposes status, and fires after the delay", async () => {
    const status = scheduleHibernate(command, 60_000);
    expect(status).toEqual({ pending: true, scheduledAt: Date.now() + 60_000, delayMs: 60_000 });
    expect(getHibernateStatus().pending).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(requestDeviceHibernateMock).toHaveBeenCalledOnce();
    expect(requestDeviceHibernateMock).toHaveBeenCalledWith(command);
    expect(getHibernateStatus().pending).toBe(false);
  });

  it("cancel prevents the scheduled hibernation from firing", async () => {
    scheduleHibernate(command, 30_000);
    expect(cancelHibernate()).toBe(true);
    expect(getHibernateStatus().pending).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
    expect(cancelHibernate()).toBe(false);
  });

  it("replacing a schedule does not let the stale timer fire", async () => {
    scheduleHibernate(command, 10_000);
    const replacement = scheduleHibernate(command, 60_000);
    expect(replacement.delayMs).toBe(60_000);

    // Original 10s window passes: stale timer must not trigger hibernation.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
    expect(getHibernateStatus().pending).toBe(true);

    // Remaining time on the replacement passes: it fires exactly once.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(requestDeviceHibernateMock).toHaveBeenCalledOnce();
  });

  it("honors a delay beyond Node's max timeout instead of firing immediately", async () => {
    const NODE_MAX_TIMEOUT_MS = 2_147_483_647; // ~24.8 days
    const extraMs = 60_000;
    const status = scheduleHibernate(command, NODE_MAX_TIMEOUT_MS + extraMs);
    expect(status.delayMs).toBe(NODE_MAX_TIMEOUT_MS + extraMs);

    // Advancing to the first chunk boundary must not fire early.
    await vi.advanceTimersByTimeAsync(NODE_MAX_TIMEOUT_MS);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
    expect(getHibernateStatus().pending).toBe(true);

    // Advancing across the chunk boundary fires exactly once.
    await vi.advanceTimersByTimeAsync(extraMs);
    expect(requestDeviceHibernateMock).toHaveBeenCalledOnce();
    expect(getHibernateStatus().pending).toBe(false);
  });
});

describe("device-hibernate idle watcher", () => {
  const GRACE_MS = 2 * 60_000;

  function arm(getActiveSessionCount: () => number) {
    return armHibernateOnIdle({ command, graceMs: GRACE_MS, getActiveSessionCount });
  }

  it("reports a disarmed watcher initially", () => {
    expect(getHibernateOnIdleStatus()).toEqual({
      armed: false,
      armedAt: null,
      graceMs: null,
      activeSessions: 0,
      idleSince: null,
      hibernateAt: null,
    });
  });

  it("waits for the idle grace window before hibernating", async () => {
    const status = arm(() => 0);
    expect(status).toEqual({
      armed: true,
      armedAt: Date.now(),
      graceMs: GRACE_MS,
      activeSessions: 0,
      idleSince: Date.now(),
      hibernateAt: Date.now() + GRACE_MS,
    });

    // Arming alone must never hibernate — only a later poll tick can fire.
    await vi.advanceTimersByTimeAsync(GRACE_MS - HIBERNATE_IDLE_POLL_INTERVAL_MS);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
    expect(getHibernateOnIdleStatus().armed).toBe(true);

    await vi.advanceTimersByTimeAsync(HIBERNATE_IDLE_POLL_INTERVAL_MS);
    expect(requestDeviceHibernateMock).toHaveBeenCalledOnce();
    expect(requestDeviceHibernateMock).toHaveBeenCalledWith(command);
    // The watcher disarms itself so waking the device does not hibernate again.
    expect(getHibernateOnIdleStatus().armed).toBe(false);
  });

  it("restarts the idle window when a session becomes active", async () => {
    let activeSessions = 1;
    arm(() => activeSessions);
    expect(getHibernateOnIdleStatus()).toMatchObject({ activeSessions: 1, idleSince: null, hibernateAt: null });

    activeSessions = 0;
    await vi.advanceTimersByTimeAsync(HIBERNATE_IDLE_POLL_INTERVAL_MS);
    const idleSince = getHibernateOnIdleStatus().idleSince;
    expect(idleSince).toBe(Date.now());

    // A new turn starts before the grace window elapses.
    await vi.advanceTimersByTimeAsync(GRACE_MS - HIBERNATE_IDLE_POLL_INTERVAL_MS);
    activeSessions = 1;
    await vi.advanceTimersByTimeAsync(HIBERNATE_IDLE_POLL_INTERVAL_MS);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
    expect(getHibernateOnIdleStatus().idleSince).toBeNull();

    // The full window must pass again from the new idle point.
    activeSessions = 0;
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HIBERNATE_IDLE_POLL_INTERVAL_MS);
    expect(requestDeviceHibernateMock).toHaveBeenCalledOnce();
  });

  it("treats an activity-count failure as busy instead of hibernating", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    arm(() => {
      throw new Error("session manager unavailable");
    });

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
    expect(getHibernateOnIdleStatus()).toMatchObject({ armed: true, activeSessions: 1, idleSince: null });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("disarming stops the watcher from firing and re-arming replaces the previous watcher without double firing", async () => {
    // Disarming stops the watcher
    arm(() => 0);
    expect(disarmHibernateOnIdle()).toBe(true);
    expect(disarmHibernateOnIdle()).toBe(false);

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(requestDeviceHibernateMock, "disarmed: no fire").not.toHaveBeenCalled();

    // Re-arming replaces the previous watcher without double firing
    arm(() => 0);
    arm(() => 0);

    await vi.advanceTimersByTimeAsync(GRACE_MS + HIBERNATE_IDLE_POLL_INTERVAL_MS);
    expect(requestDeviceHibernateMock, "re-armed: exactly once").toHaveBeenCalledOnce();
  });

  it("idle hibernation drops a redundant scheduled hibernation and scheduled hibernation disarms the idle watcher", async () => {
    // Idle hibernation cancels a pending scheduled hibernation
    scheduleHibernate(command, 60 * 60_000);
    arm(() => 0);

    await vi.advanceTimersByTimeAsync(GRACE_MS + HIBERNATE_IDLE_POLL_INTERVAL_MS);
    expect(requestDeviceHibernateMock, "idle fires once").toHaveBeenCalledOnce();
    expect(getHibernateStatus().pending, "scheduled cleared by idle").toBe(false);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(requestDeviceHibernateMock, "no second fire").toHaveBeenCalledOnce();

    // Scheduled hibernation disarms the idle watcher when it fires
    requestDeviceHibernateMock.mockReset();
    requestDeviceHibernateMock.mockResolvedValue(command);
    cancelHibernate();
    disarmHibernateOnIdle();

    arm(() => 1);
    scheduleHibernate(command, 30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestDeviceHibernateMock, "scheduled fires once").toHaveBeenCalledOnce();
    expect(getHibernateOnIdleStatus().armed, "idle watcher disarmed").toBe(false);
  });
});
