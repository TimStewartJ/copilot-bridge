import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  closeHeadedDiagnosticsBrowser,
  requestBrowserLiveTicket,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser diagnostics and live view APIs", () => {
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
      remainingPids: [4242],
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
        remainingPids: [4242],
      }),
    });
  });
});
