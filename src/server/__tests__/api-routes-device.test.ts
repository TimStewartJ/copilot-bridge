import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, createTestApp, eventually } from "./api-routes-test-helpers.js";
import { getDeviceHibernateCommand, requestDeviceHibernate } from "../platform.js";

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
  getDeviceHibernateCommandMock.mockReset();
  getDeviceHibernateCommandMock.mockReturnValue(linuxHibernateCommand);
  requestDeviceHibernateMock.mockReset();
});

afterEach(() => {
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
      message: "Hibernate requested. This device may sleep shortly.",
    });
    expect(requestDeviceHibernateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    await eventually(() => expect(requestDeviceHibernateMock).toHaveBeenCalledOnce());
    expect(requestDeviceHibernateMock).toHaveBeenCalledWith(linuxHibernateCommand);
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
