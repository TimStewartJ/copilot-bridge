import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, createTestApp, createMockSessionManager, eventually } from "./api-routes-test-helpers.js";
import { getDeviceHibernateCommand, requestDeviceHibernate } from "../platform.js";
import { cancelHibernate, disarmHibernateOnIdle, getHibernateOnIdleStatus, HIBERNATE_IDLE_POLL_INTERVAL_MS } from "../device-hibernate.js";
import type { AppContext } from "../app-context.js";

vi.mock("../platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform.js")>();
  return {
    ...actual,
    getDeviceHibernateCommand: vi.fn(),
    requestDeviceHibernate: vi.fn(),
  };
});

const getDeviceHibernateCommandMock = vi.mocked(getDeviceHibernateCommand);
const requestDeviceHibernateMock = vi.mocked(requestDeviceHibernate);
const linuxHibernateCommand = {
  platform: "linux" as const,
  command: "systemctl",
  args: ["hibernate"],
};
const disarmedOnIdle = {
  armed: false,
  armedAt: null,
  graceMs: null,
  activeSessions: 0,
  idleSince: null,
  hibernateAt: null,
  blockedReason: null,
};

beforeEach(() => {
  cancelHibernate();
  disarmHibernateOnIdle();
  getDeviceHibernateCommandMock.mockReset();
  getDeviceHibernateCommandMock.mockReturnValue(linuxHibernateCommand);
  requestDeviceHibernateMock.mockReset();
});

afterEach(() => {
  cancelHibernate();
  disarmHibernateOnIdle();
  vi.useRealTimers();
});

describe("Device management routes", () => {
  it("POST /api/device/hibernate is unavailable in staging", async () => {
    const { app } = createTestApp({ isStaging: true });

    const res = await request(app)
      .post("/api/device/hibernate")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not available in staging" });
    expect(getDeviceHibernateCommandMock).not.toHaveBeenCalled();
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
  });

  it("POST /api/device/hibernate rejects unsupported platforms before scheduling", async () => {
    getDeviceHibernateCommandMock.mockImplementation(() => {
      throw new Error("Device hibernation is not supported on macOS by Copilot Bridge.");
    });
    const { app } = createTestApp();

    const res = await request(app)
      .post("/api/device/hibernate")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Device hibernation is not supported on macOS by Copilot Bridge.",
    });
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
  });

  it("POST /api/device/hibernate acknowledges before requesting hibernation", async () => {
    vi.useFakeTimers();
    requestDeviceHibernateMock.mockResolvedValue({
      platform: "linux",
      command: "systemctl",
      args: ["hibernate"],
    });
    const { app } = createTestApp();

    const res = await request(app)
      .post("/api/device/hibernate")
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      ok: true,
      pending: false,
      scheduledAt: null,
      delayMs: null,
      onIdle: disarmedOnIdle,
      message: "Hibernate requested. This device may sleep shortly.",
    });
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    await eventually(() => expect(requestDeviceHibernateMock).toHaveBeenCalledOnce());
    expect(requestDeviceHibernateMock).toHaveBeenCalledWith(linuxHibernateCommand);
  });

  it("POST /api/device/hibernate rejects invalid delay values", async () => {
    const { app } = createTestApp();

    const res = await request(app)
      .post("/api/device/hibernate")
      .send({ delayMinutes: 7 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("delayMinutes must be one of");
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
  });

  it("POST /api/device/hibernate schedules a delayed hibernation and reports pending status", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-06T12:00:00.000Z") });
    requestDeviceHibernateMock.mockResolvedValue(linuxHibernateCommand);
    const { app } = createTestApp();

    const res = await request(app)
      .post("/api/device/hibernate")
      .send({ delayMinutes: 5 });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      ok: true,
      pending: true,
      delayMs: 5 * 60_000,
      scheduledAt: Date.now() + 5 * 60_000,
    });
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();

    const statusRes = await request(app).get("/api/device/hibernate");
    expect(statusRes.body).toMatchObject({ pending: true, delayMs: 5 * 60_000 });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await eventually(() => expect(requestDeviceHibernateMock).toHaveBeenCalledOnce());
    expect(requestDeviceHibernateMock).toHaveBeenCalledWith(linuxHibernateCommand);

    const clearedRes = await request(app).get("/api/device/hibernate");
    expect(clearedRes.body).toEqual({
      pending: false,
      scheduledAt: null,
      delayMs: null,
      onIdle: disarmedOnIdle,
    });
  });

  it("POST /api/device/hibernate/cancel clears a pending scheduled hibernation", async () => {
    vi.useFakeTimers();
    requestDeviceHibernateMock.mockResolvedValue(linuxHibernateCommand);
    const { app } = createTestApp();

    await request(app).post("/api/device/hibernate").send({ delayMinutes: 30 });

    const cancelRes = await request(app).post("/api/device/hibernate/cancel").send({});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body).toEqual({
      ok: true,
      cancelled: true,
      pending: false,
      scheduledAt: null,
      delayMs: null,
      onIdle: disarmedOnIdle,
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();
  });

  it("POST /api/device/hibernate/cancel reports when nothing is pending", async () => {
    const { app } = createTestApp();

    const res = await request(app).post("/api/device/hibernate/cancel").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cancelled: false, pending: false });
  });

  it("POST /api/device/hibernate/cancel is unavailable in staging", async () => {
    const { app } = createTestApp({ isStaging: true });

    const res = await request(app).post("/api/device/hibernate/cancel").send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not available in staging" });
  });

  it("logs background hibernate failures", async () => {
    vi.useFakeTimers();
    const error = new Error("hibernate unavailable");
    requestDeviceHibernateMock.mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = createTestApp();

    const res = await request(app)
      .post("/api/device/hibernate")
      .send({});

    expect(res.status).toBe(202);
    await vi.advanceTimersByTimeAsync(250);
    await eventually(() => expect(errorSpy).toHaveBeenCalledWith("[device] Hibernate request failed:", error));
  });

  it("POST /api/device/hibernate/on-idle arms the watcher and hibernates once sessions go idle", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-06T12:00:00.000Z") });
    requestDeviceHibernateMock.mockResolvedValue(linuxHibernateCommand);
    let activeSessions = 2;
    const { app } = createTestApp({
      sessionManager: {
        ...createMockSessionManager(),
        getLifecycleBlockingSessionCount: () => activeSessions,
      },
    });

    const res = await request(app)
      .post("/api/device/hibernate/on-idle")
      .send({ enabled: true, graceMinutes: 1 });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      ok: true,
      armed: true,
      graceMs: 60_000,
      activeSessions: 2,
      idleSince: null,
      hibernateAt: null,
    });

    const statusRes = await request(app).get("/api/device/hibernate");
    expect(statusRes.body.onIdle).toMatchObject({ armed: true, activeSessions: 2 });

    // Busy sessions hold hibernation off indefinitely.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();

    activeSessions = 0;
    await vi.advanceTimersByTimeAsync(60_000 + 2 * HIBERNATE_IDLE_POLL_INTERVAL_MS);
    await eventually(() => expect(requestDeviceHibernateMock).toHaveBeenCalledOnce());
    expect(requestDeviceHibernateMock).toHaveBeenCalledWith(linuxHibernateCommand);
    expect(getHibernateOnIdleStatus().armed).toBe(false);
  });

  it("POST /api/device/hibernate/on-idle holds hibernation while a deploy job is active", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-06T12:00:00.000Z") });
    requestDeviceHibernateMock.mockResolvedValue(linuxHibernateCommand);
    let activeJobs: unknown[] = [{
      id: "job-1",
      type: "staging_deploy",
      status: "running",
      input: {},
      createdAt: "2026-06-06T11:59:00.000Z",
      updatedAt: "2026-06-06T11:59:00.000Z",
    }];
    const { app } = createTestApp({
      sessionManager: {
        ...createMockSessionManager(),
        getLifecycleBlockingSessionCount: () => 0,
      },
      managementJobStore: {
        listActive: () => activeJobs,
      } as unknown as AppContext["managementJobStore"],
    });

    const res = await request(app)
      .post("/api/device/hibernate/on-idle")
      .send({ enabled: true, graceMinutes: 1 });

    // Zero active sessions, but a cutover is in flight — the watcher must hold.
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      armed: true,
      activeSessions: 0,
      idleSince: null,
      hibernateAt: null,
      blockedReason: "A staging_deploy management job is running",
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();

    const statusRes = await request(app).get("/api/device/hibernate");
    expect(statusRes.body.onIdle).toMatchObject({
      armed: true,
      blockedReason: "A staging_deploy management job is running",
    });

    activeJobs = [];
    await vi.advanceTimersByTimeAsync(60_000 + 2 * HIBERNATE_IDLE_POLL_INTERVAL_MS);
    await eventually(() => expect(requestDeviceHibernateMock).toHaveBeenCalledOnce());
  });

  it("POST /api/device/hibernate/on-idle disarms the watcher when disabled", async () => {    vi.useFakeTimers({ now: new Date("2026-06-06T12:00:00.000Z") });
    requestDeviceHibernateMock.mockResolvedValue(linuxHibernateCommand);
    const { app } = createTestApp();

    await request(app).post("/api/device/hibernate/on-idle").send({ enabled: true, graceMinutes: 1 });
    expect(getHibernateOnIdleStatus().armed).toBe(true);

    const res = await request(app).post("/api/device/hibernate/on-idle").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, disarmed: true, armed: false });
    expect(getHibernateOnIdleStatus().armed).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();

    const repeatRes = await request(app).post("/api/device/hibernate/on-idle").send({ enabled: false });
    expect(repeatRes.body).toMatchObject({ ok: true, disarmed: false, armed: false });
  });

  it("POST /api/device/hibernate/on-idle rejects invalid input", async () => {
    const { app } = createTestApp();

    const graceRes = await request(app)
      .post("/api/device/hibernate/on-idle")
      .send({ enabled: true, graceMinutes: 7 });
    expect(graceRes.status).toBe(400);
    expect(graceRes.body.error).toContain("graceMinutes must be one of");

    const enabledRes = await request(app)
      .post("/api/device/hibernate/on-idle")
      .send({ enabled: "yes" });
    expect(enabledRes.status).toBe(400);
    expect(enabledRes.body).toEqual({ error: "enabled must be a boolean." });
    expect(getHibernateOnIdleStatus().armed).toBe(false);
  });

  it("POST /api/device/hibernate/on-idle rejects unsupported platforms before arming", async () => {
    getDeviceHibernateCommandMock.mockImplementation(() => {
      throw new Error("Device hibernation is not supported on macOS by Copilot Bridge.");
    });
    const { app } = createTestApp();

    const res = await request(app).post("/api/device/hibernate/on-idle").send({ enabled: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Device hibernation is not supported on macOS by Copilot Bridge.",
    });
    expect(getHibernateOnIdleStatus().armed).toBe(false);
  });

  it("POST /api/device/hibernate/on-idle is unavailable in staging", async () => {
    const { app } = createTestApp({ isStaging: true });

    const res = await request(app).post("/api/device/hibernate/on-idle").send({ enabled: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not available in staging" });
    expect(getHibernateOnIdleStatus().armed).toBe(false);
  });

  it("an immediate hibernate request disarms the idle watcher", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-06T12:00:00.000Z") });
    requestDeviceHibernateMock.mockResolvedValue(linuxHibernateCommand);
    const { app } = createTestApp();

    await request(app).post("/api/device/hibernate/on-idle").send({ enabled: true, graceMinutes: 5 });
    expect(getHibernateOnIdleStatus().armed).toBe(true);

    const res = await request(app).post("/api/device/hibernate").send({});
    expect(res.body.onIdle).toEqual(disarmedOnIdle);
    expect(getHibernateOnIdleStatus().armed).toBe(false);
  });
});
