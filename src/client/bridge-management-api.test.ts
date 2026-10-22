import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  evictIdleCache,
  fetchBridgeRuntimeStatus,
  restartBridge,
} from "./bridge-management-api";

function stubJsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bridge management client API", () => {
  it("calls the runtime, cache and restart endpoints with the restart options in the body", async () => {
    stubJsonResponse({ ok: true });

    await fetchBridgeRuntimeStatus();
    await evictIdleCache();
    await restartBridge();
    await restartBridge({ force: true, resume: true });

    const post = (body: string) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(vi.mocked(fetch).mock.calls).toEqual([
      ["/api/server/runtime-status", { signal: undefined }],
      ["/api/server/cache/evict-idle", post("{}")],
      ["/api/server/restart", post("{\"force\":false}")],
      ["/api/server/restart", post("{\"force\":true,\"resume\":true}")],
    ]);
  });

  it("surfaces restart errors as ApiError", async () => {
    stubJsonResponse(
      { error: "A restart is already pending.", details: { phase: "queued" } },
      { ok: false, status: 409, statusText: "Conflict" },
    );

    await expect(restartBridge()).rejects.toMatchObject({
      name: "ApiError",
      message: "A restart is already pending.",
      status: 409,
      details: { phase: "queued" },
    });
    await expect(restartBridge()).rejects.toBeInstanceOf(ApiError);
  });
});
