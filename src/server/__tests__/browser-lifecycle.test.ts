import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { BrowserBroker } from "../browser-broker.js";
import { createBridgeBrowserLifecycle, noopBrowserLifecycle } from "../browser-lifecycle.js";
import { makeTestDir } from "./helpers.js";

const shutdownTarget = vi.fn();

/** A lifecycle over a broker whose authenticated profile lives in a temp folder. */
function makeLifecycle(options: { createProfile?: boolean } = {}) {
  const copilotHome = join(makeTestDir("bridge-lifecycle"), ".copilot");
  const profileDir = join(copilotHome, "browser-profile");
  if (options.createProfile !== false) mkdirSync(profileDir, { recursive: true });
  const lifecycle = createBridgeBrowserLifecycle(new BrowserBroker({ copilotHome, shutdownTarget }));
  return { lifecycle, profileDir };
}

describe("browser-lifecycle", () => {
  beforeEach(() => {
    shutdownTarget.mockReset();
    shutdownTarget.mockResolvedValue({
      ok: true,
      closeOk: true,
      terminatedPids: [],
      killedPids: [],
      remainingPids: [],
      clearedRuntimeFiles: 0,
    });
  });

  describe("createBridgeBrowserLifecycle", () => {
    it.each([
      ["does not exist", false],
      ["exists but has no runtime markers", true],
    ])("skips shutdown when the profile directory %s", async (_name, createProfile) => {
      const { lifecycle } = makeLifecycle({ createProfile });

      const outcome = await lifecycle.shutdown();

      expect(outcome).toMatchObject({ skipped: true, reason: "no_browser_activity" });
      expect(shutdownTarget).not.toHaveBeenCalled();
    });

    it.each([
      ["SingletonLock", ""],
      ["DevToolsActivePort", "12345\n"],
    ])("shuts the broker's authenticated browser down when %s is present", async (marker, content) => {
      const { lifecycle, profileDir } = makeLifecycle();
      writeFileSync(join(profileDir, marker), content);

      const outcome = await lifecycle.shutdown();

      expect(outcome).toMatchObject({ skipped: false, ok: true, target: { profileDir } });
      expect(shutdownTarget).toHaveBeenCalledTimes(1);
      expect(shutdownTarget.mock.calls[0][0]).toMatchObject({ profileDir });
    });

    it("detects dangling SingletonLock symlinks on POSIX without following them", async () => {
      if (process.platform === "win32") return;
      const { lifecycle, profileDir } = makeLifecycle();
      symlinkSync("/proc/12345", join(profileDir, "SingletonLock"));

      const outcome = await lifecycle.shutdown();

      expect(outcome.skipped).toBe(false);
      expect(shutdownTarget).toHaveBeenCalledTimes(1);
    });

    it("propagates errors from the shutdown", async () => {
      const { lifecycle, profileDir } = makeLifecycle();
      writeFileSync(join(profileDir, "SingletonLock"), "");
      shutdownTarget.mockRejectedValueOnce(new Error("close failed"));

      await expect(lifecycle.shutdown()).rejects.toThrow("close failed");
    });
  });

  describe("noopBrowserLifecycle", () => {
    it("never shuts a browser down", async () => {
      const outcome = await noopBrowserLifecycle.shutdown();
      expect(outcome).toEqual({ skipped: true, reason: "disabled" });
      expect(shutdownTarget).not.toHaveBeenCalled();
    });
  });
});
