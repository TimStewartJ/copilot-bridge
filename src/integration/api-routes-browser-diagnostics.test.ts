import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-support/api-routes.js";
import { createTestApp } from "../test-support/api-routes.js";
import { testPath } from "../server/__tests__/test-paths.js";
import {
  BrowserHeadedCloseError,
  checkAdoBrowserAuthentication,
  closeHeadedDiagnosticsBrowser,
  probeBrowserContext,
} from "../server/browser-diagnostics.js";

vi.mock("../server/browser-diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/browser-diagnostics.js")>();
  return {
    ...actual,
    checkAdoBrowserAuthentication: vi.fn(),
    closeHeadedDiagnosticsBrowser: vi.fn(),
    probeBrowserContext: vi.fn(),
  };
});

const checkAdoBrowserAuthenticationMock = vi.mocked(checkAdoBrowserAuthentication);
const closeHeadedDiagnosticsBrowserMock = vi.mocked(closeHeadedDiagnosticsBrowser);
const probeBrowserContextMock = vi.mocked(probeBrowserContext);

beforeEach(() => {
  closeHeadedDiagnosticsBrowserMock.mockReset();
  probeBrowserContextMock.mockReset();
  checkAdoBrowserAuthenticationMock.mockReset();
  closeHeadedDiagnosticsBrowserMock.mockResolvedValue({
    ok: true,
    sessionName: "copilot-bridge-test",
    masterProfileDirectory: testPath("browser-profile"),
    message: "Headed browser close requested. Verified browser state is ready for future browser tool runs.",
  });
  probeBrowserContextMock.mockResolvedValue({
    ok: true,
    context: "public",
    state: "ready",
    checkedAt: new Date().toISOString(),
  });
  checkAdoBrowserAuthenticationMock.mockResolvedValue({
    service: "ado",
    state: "verified",
    checkedAt: new Date().toISOString(),
    finalOrigin: "https://msazure.visualstudio.com",
    expectedOrigin: "https://msazure.visualstudio.com",
  });
});

describe("Browser diagnostics routes", () => {
  it("GET /api/browser/diagnostics returns separate browser contexts", async () => {
    const local = createTestApp();

    const res = await request(local.app).get("/api/browser/diagnostics");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      schemaVersion: 2,
      runtime: {
        transport: {
          kind: "cli",
          namespace: "copilot-bridge",
        },
      },
      contexts: {
        public: { context: "public" },
        authenticated: { context: "authenticated" },
      },
    });
  });

  it("POST /api/browser/diagnostics/launch-headed rejects cross-site requests", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/launch-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "https://evil.example.test")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Headed browser launch must be started from the Bridge UI.");
  });

  it("POST /api/browser/diagnostics/close-headed rejects cross-site requests", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/close-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "https://evil.example.test")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Headed browser close must be started from the Bridge UI.");
  });

  it("POST /api/browser/diagnostics/probe checks the requested context", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/probe")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({ context: "public" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, context: "public", state: "ready" });
    expect(probeBrowserContextMock).toHaveBeenCalledWith(expect.anything(), "public");
  });

  it("POST /api/browser/diagnostics/authenticated/check/ado verifies authentication", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/authenticated/check/ado")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      service: "ado",
      state: "verified",
    });
    expect(checkAdoBrowserAuthenticationMock).toHaveBeenCalledWith(expect.anything());
  });

  it("authenticated browser aliases preserve close behavior", async () => {
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/authenticated/close-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({});

    expect(res.status).toBe(200);
    expect(closeHeadedDiagnosticsBrowserMock).toHaveBeenCalledWith(expect.anything());
  });

  it("POST /api/browser/diagnostics/close-headed returns close failure details", async () => {
    closeHeadedDiagnosticsBrowserMock.mockRejectedValue(new BrowserHeadedCloseError({
      ok: false,
      failureCode: "launch.timeout",
      outputSummary: "timed out closing the profile",
      closeOk: false,
      closeFailureCode: "launch.timeout",
      closeOutputSummary: "timed out closing the profile",
      terminatedPids: [],
      killedPids: [],
      remainingPids: [],
      clearedRuntimeFiles: 0,
    }));
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/close-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("agent-browser close failed (launch.timeout)");
    expect(res.body.details).toMatchObject({
      failureCode: "launch.timeout",
      closeFailureCode: "launch.timeout",
      remainingPids: [],
    });
  });

  it("POST /api/browser/diagnostics/close-headed returns remaining PID details", async () => {
    closeHeadedDiagnosticsBrowserMock.mockRejectedValue(new BrowserHeadedCloseError({
      ok: false,
      failureCode: "profile_processes_remaining",
      outputSummary: "Profile-bound browser processes remain after shutdown: 4242",
      closeOk: true,
      terminatedPids: [4242],
      killedPids: [],
      remainingPids: [4242],
      clearedRuntimeFiles: 0,
    }));
    const local = createTestApp();

    const res = await request(local.app)
      .post("/api/browser/diagnostics/close-headed")
      .set("Host", "localhost:3333")
      .set("Origin", "http://localhost:3333")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("remaining profile-bound browser process PIDs: 4242");
    expect(res.body.details).toMatchObject({
      failureCode: "profile_processes_remaining",
      remainingPids: [4242],
    });
  });
});
