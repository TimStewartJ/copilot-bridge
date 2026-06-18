import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestDeviceHibernate, type DeviceHibernateCommand } from "../platform.js";
import { cancelHibernate, getHibernateStatus, scheduleHibernate } from "../device-hibernate.js";

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
  requestDeviceHibernateMock.mockReset();
  requestDeviceHibernateMock.mockResolvedValue(command);
  vi.useFakeTimers({ now: new Date("2026-06-06T00:00:00.000Z") });
});

afterEach(() => {
  cancelHibernate();
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
