import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "./api-routes-test-helpers.js";
import { createTestApp } from "./helpers.js";
import { testPath } from "./test-paths.js";
import { BrowserHeadedCloseError, closeHeadedDiagnosticsBrowser } from "../browser-diagnostics.js";

vi.mock("../browser-diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser-diagnostics.js")>();
  return {
    ...actual,
    closeHeadedDiagnosticsBrowser: vi.fn(),
  };
});

const closeHeadedDiagnosticsBrowserMock = vi.mocked(closeHeadedDiagnosticsBrowser);

beforeEach(() => {
  closeHeadedDiagnosticsBrowserMock.mockReset();
  closeHeadedDiagnosticsBrowserMock.mockResolvedValue({
    ok: true,
    sessionName: "copilot-bridge-test",
    masterProfileDirectory: testPath("browser-profile"),
    message: "Headed browser close requested. Verified browser state is ready for future browser tool runs.",
  });
});

describe("Browser diagnostics routes", () => {
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
