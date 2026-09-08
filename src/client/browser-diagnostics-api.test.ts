import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  checkAdoBrowserAuthentication,
  closeHeadedDiagnosticsBrowser,
  probeBrowserContext,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser context diagnostics APIs", () => {
  it("probes the selected browser context", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        ok: true,
        context: "public",
        state: "ready",
      }),
      input,
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeBrowserContext("public")).resolves.toMatchObject({
      ok: true,
      context: "public",
      state: "ready",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser/diagnostics/probe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ context: "public" }),
      }),
    );
  });

  it("requests an authenticated Azure DevOps check", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        service: "ado",
        state: "verified",
        checkedAt: "2026-09-08T16:00:00.000Z",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkAdoBrowserAuthentication()).resolves.toMatchObject({
      service: "ado",
      state: "verified",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser/diagnostics/authenticated/check/ado",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("closeHeadedDiagnosticsBrowser", () => {
  function mockCloseFailure(details: Record<string, unknown>) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/browser/diagnostics/close-headed") {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({
            error: "Headed browser close did not leave the browser profile clean.",
            details,
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));
  }

  it("surfaces headed close command failure details", async () => {
    mockCloseFailure({
      failureCode: "launch.timeout",
      closeFailureCode: "launch.timeout",
      closeOutputSummary: "timed out closing the profile",
      terminatedPids: [],
      killedPids: [],
      remainingPids: [],
      clearedRuntimeFiles: 0,
    });

    const request = closeHeadedDiagnosticsBrowser();
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "Headed browser close did not leave the browser profile clean.",
      details: expect.objectContaining({
        failureCode: "launch.timeout",
        closeFailureCode: "launch.timeout",
        remainingPids: [],
      }),
    });
  });

  it("surfaces headed close remaining PID details", async () => {
    mockCloseFailure({
      failureCode: "profile_processes_remaining",
      outputSummary: "Profile-bound browser processes remain after shutdown: 4242",
      terminatedPids: [4242],
      killedPids: [],
      remainingPids: [4242],
      clearedRuntimeFiles: 0,
    });

    const request = closeHeadedDiagnosticsBrowser();
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      details: expect.objectContaining({
        failureCode: "profile_processes_remaining",
        remainingPids: [4242],
      }),
    });
  });
});
