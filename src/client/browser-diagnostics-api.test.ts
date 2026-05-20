import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, closeHeadedDiagnosticsBrowser } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
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
