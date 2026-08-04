import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { makeTestDir } from "./helpers.js";
import { createPreviewTarget } from "../staging-preview-shared.js";

const PREFIX = "deadbeef";

async function loadManager() {
  vi.resetModules();
  return import("../staging-backend-manager.js");
}

beforeEach(() => {
  vi.stubEnv("BRIDGE_STAGING_BACKEND_START_MAX_ATTEMPTS", "3");
});

afterEach(async () => {
  const mod = await loadManager();
  mod.__testing.resetBackendState();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("lazy staging backend startup failures are bounded", () => {
  it("applies an increasing retry cooldown for each recorded failure", async () => {
    const mod = await loadManager();
    mod.__testing.resetBackendState();

    const before = Date.now();
    mod.__testing.recordStartFailure(PREFIX, "boom 1");
    const first = mod.__testing.getStartFailure(PREFIX)!;
    expect(first.attempts).toBe(1);
    expect(first.error).toBe("boom 1");
    expect(first.nextRetryAt).toBeGreaterThan(before);

    mod.__testing.recordStartFailure(PREFIX, "boom 2");
    const second = mod.__testing.getStartFailure(PREFIX)!;
    expect(second.attempts).toBe(2);
    expect(second.nextRetryAt - Date.now()).toBeGreaterThan(first.nextRetryAt - before);
  });

  it("removes the dead preview route once startup fails past the attempt cap", async () => {
    const mod = await loadManager();
    mod.__testing.resetBackendState();

    const stagingDir = makeTestDir("staging-dead-preview");
    const target = { ...createPreviewTarget(stagingDir), prefix: PREFIX };
    mod.rememberRestorablePreviewTarget(target);
    expect(mod.__testing.ensureLazyRouter(PREFIX)).toBe(true);
    expect(mod.__testing.hasLazyRouter(PREFIX)).toBe(true);

    mod.__testing.recordStartFailure(PREFIX, "boom 1");
    mod.__testing.recordStartFailure(PREFIX, "boom 2");
    expect(mod.__testing.hasRestorableTarget(PREFIX)).toBe(true);

    // Third failure hits BRIDGE_STAGING_BACKEND_START_MAX_ATTEMPTS=3.
    mod.__testing.recordStartFailure(PREFIX, "boom 3");

    expect(mod.__testing.hasRestorableTarget(PREFIX)).toBe(false);
    expect(mod.__testing.hasLazyRouter(PREFIX)).toBe(false);
    expect(mod.__testing.getStartFailure(PREFIX)).toBeUndefined();
    // With the target gone the prefix falls through to the normal 404 path
    // instead of answering 502 forever.
    expect(mod.getStagingRouter(PREFIX)).toBeUndefined();
  });

  it("keeps a retired preview retired until its build artifacts are rebuilt", async () => {
    const mod = await loadManager();
    mod.__testing.resetBackendState();

    const stagingDir = makeTestDir("staging-retired-preview");
    const target = { ...createPreviewTarget(stagingDir), prefix: PREFIX };
    mod.rememberRestorablePreviewTarget(target);

    const retiredAtLowerBound = Date.now();
    for (let i = 0; i < 3; i++) mod.__testing.recordStartFailure(PREFIX, `boom ${i}`);
    expect(mod.__testing.hasRestorableTarget(PREFIX)).toBe(false);

    // A dist directory that predates the retirement stays retired, so discovery
    // will not immediately re-register the backend it just gave up on.
    expect(mod.isPreviewRetiredAfterStartFailures(PREFIX, retiredAtLowerBound - 1_000)).toBe(true);

    // A rebuilt preview (newer artifacts) clears the tombstone.
    expect(mod.isPreviewRetiredAfterStartFailures(PREFIX, Date.now() + 60_000)).toBe(false);
    expect(mod.isPreviewRetiredAfterStartFailures(PREFIX, retiredAtLowerBound - 1_000)).toBe(false);
  });

  it("clears the retirement tombstone when the preview is explicitly re-registered", async () => {
    const mod = await loadManager();
    mod.__testing.resetBackendState();

    const stagingDir = makeTestDir("staging-reregistered-preview");
    const target = { ...createPreviewTarget(stagingDir), prefix: PREFIX };
    for (let i = 0; i < 3; i++) mod.__testing.recordStartFailure(PREFIX, `boom ${i}`);
    expect(mod.__testing.isRetired(PREFIX, 0)).toBe(true);

    mod.rememberRestorablePreviewTarget(target);

    expect(mod.__testing.isRetired(PREFIX, 0)).toBe(false);
    expect(mod.__testing.hasRestorableTarget(PREFIX)).toBe(true);
  });

  it("records a cooldown when startup throws instead of returning a failure", async () => {
    const mod = await loadManager();
    mod.__testing.resetBackendState();

    const stagingDir = makeTestDir("staging-throwing-preview");
    const target = { ...createPreviewTarget(stagingDir), prefix: PREFIX };

    // Resource-limit enforcement runs before restore and used to bypass the
    // backoff entirely when it threw, letting the next request respawn at once.
    const result = await mod.__testing.startRestorableBackend(PREFIX, target, "test", {
      enforceLimits: async () => { throw new Error("resource limit exceeded"); },
    });

    expect(result).toMatchObject({ ok: false, error: "resource limit exceeded" });
    const failure = mod.__testing.getStartFailure(PREFIX);
    expect(failure).toBeDefined();
    expect(failure!.attempts).toBe(1);
    expect(failure!.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it("records a cooldown when restore rejects rather than resolving", async () => {
    const mod = await loadManager();
    mod.__testing.resetBackendState();

    const stagingDir = makeTestDir("staging-rejecting-restore");
    const target = { ...createPreviewTarget(stagingDir), prefix: PREFIX };

    const result = await mod.__testing.startRestorableBackend(PREFIX, target, "test", {
      enforceLimits: async () => {},
      restore: async () => { throw new Error("restore rejected"); },
    });

    expect(result).toMatchObject({ ok: false, error: "restore rejected" });
    expect(mod.__testing.getStartFailure(PREFIX)?.attempts).toBe(1);
  });
});

describe("lazy staging request rejections", () => {
  it("forwards a handler rejection to next() instead of hanging the request", async () => {
    const mod = await loadManager();
    mod.__testing.resetBackendState();

    const stagingDir = makeTestDir("staging-lazy-reject");
    const target = { ...createPreviewTarget(stagingDir), prefix: PREFIX };
    mod.rememberRestorablePreviewTarget(target);
    // A recorded failure puts the prefix in its retry cooldown, so the handler
    // reaches the failure response path without spawning a backend.
    mod.__testing.recordStartFailure(PREFIX, "boom");

    const router = mod.__testing.getLazyRouter(PREFIX);
    expect(router).toBeDefined();

    const failure = new Error("response already destroyed");
    const res = {
      setHeader() {
        throw failure;
      },
      status() {
        throw new Error("status should not be reached");
      },
    };
    const next = vi.fn();

    router!({} as never, res as never, next as never);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(failure));
    expect(next).toHaveBeenCalledTimes(1);
  });
});
