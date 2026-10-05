import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  checkAdoBrowserAuthentication,
  closeHeadedDiagnosticsBrowser,
  probeBrowserContext,
  requestBrowserLiveTicket,
  resetPublicBrowserData,
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

describe("public browser reset and live view APIs", () => {
  it("clears public browsing data", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, cleared: 3, inUse: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resetPublicBrowserData()).resolves.toEqual({ ok: true, cleared: 3, inUse: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser/diagnostics/public/reset",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("asks for a live view ticket for one browser session", async () => {
    const ticket = { browserSessionId: "bs_ab12cd34", token: "secret", expiresAt: "2026-10-04T18:30:00.000Z" };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ticket }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestBrowserLiveTicket("bs_ab12cd34")).resolves.toEqual(ticket);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser/sessions/bs_ab12cd34/live",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("reports the server's reason when a live view is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "This browser session has ended." }),
    })));

    const request = requestBrowserLiveTicket("bs/odd id");
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({ status: 404, message: "This browser session has ended." });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/browser/sessions/bs%2Fodd%20id/live");
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
