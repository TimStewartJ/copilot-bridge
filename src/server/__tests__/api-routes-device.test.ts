import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, createTestApp, eventually } from "./api-routes-test-helpers.js";
import { getDeviceHibernateCommand, requestDeviceHibernate } from "../platform.js";
import { cancelHibernate } from "../device-hibernate.js";

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

beforeEach(() => {
  cancelHibernate();
  getDeviceHibernateCommandMock.mockReset();
  getDeviceHibernateCommandMock.mockReturnValue(linuxHibernateCommand);
  requestDeviceHibernateMock.mockReset();
});

afterEach(() => {
  cancelHibernate();
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
    expect(clearedRes.body).toEqual({ pending: false, scheduledAt: null, delayMs: null });
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
});
