import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTestDir } from "./helpers.js";

const { shutdownBridgeBrowserMock } = vi.hoisted(() => ({
  shutdownBridgeBrowserMock: vi.fn(),
}));

vi.mock("../agent-browser.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-browser.js")>("../agent-browser.js");
  return {
    ...actual,
    shutdownBridgeBrowser: shutdownBridgeBrowserMock,
  };
});

const { createBridgeBrowserLifecycle, noopBrowserLifecycle } = await import("../browser-lifecycle.js");

function makeTempCopilotHome(): { copilotHome: string; profileDir: string } {
  const root = makeTestDir("bridge-lifecycle");
  const copilotHome = join(root, ".copilot");
  const profileDir = join(copilotHome, "browser-profile");
  mkdirSync(profileDir, { recursive: true });
  return { copilotHome, profileDir };
}

describe("browser-lifecycle", () => {
  beforeEach(() => {
    shutdownBridgeBrowserMock.mockReset();
    shutdownBridgeBrowserMock.mockResolvedValue({
      ok: true,
      closeOk: true,
      terminatedPids: [],
      killedPids: [],
      remainingPids: [],
      clearedRuntimeFiles: 0,
    });
  });

  describe("createBridgeBrowserLifecycle", () => {
    it("skips shutdown when profile directory does not exist", async () => {
      const root = makeTestDir("bridge-lifecycle-missing");
      const lifecycle = createBridgeBrowserLifecycle({ copilotHome: join(root, "absent") });

      const outcome = await lifecycle.shutdown();

      expect(outcome.skipped).toBe(true);
      if (outcome.skipped) expect(outcome.reason).toBe("no_browser_activity");
      expect(shutdownBridgeBrowserMock).not.toHaveBeenCalled();
    });

    it("skips shutdown when profile directory exists but has no runtime markers", async () => {
      const env = makeTempCopilotHome();
      const lifecycle = createBridgeBrowserLifecycle({ copilotHome: env.copilotHome });

      const outcome = await lifecycle.shutdown();

      expect(outcome.skipped).toBe(true);
      if (outcome.skipped) expect(outcome.reason).toBe("no_browser_activity");
      expect(shutdownBridgeBrowserMock).not.toHaveBeenCalled();
    });

    it("runs full shutdown when SingletonLock is present", async () => {
      const env = makeTempCopilotHome();
      writeFileSync(join(env.profileDir, "SingletonLock"), "");
      const lifecycle = createBridgeBrowserLifecycle({ copilotHome: env.copilotHome });

      const outcome = await lifecycle.shutdown();

      expect(outcome.skipped).toBe(false);
      expect(shutdownBridgeBrowserMock).toHaveBeenCalledTimes(1);
      const [target] = shutdownBridgeBrowserMock.mock.calls[0];
      expect(target.profileDir).toBe(env.profileDir);
    });

    it("runs full shutdown when DevToolsActivePort is present", async () => {
      const env = makeTempCopilotHome();
      writeFileSync(join(env.profileDir, "DevToolsActivePort"), "12345\n");
      const lifecycle = createBridgeBrowserLifecycle({ copilotHome: env.copilotHome });

      const outcome = await lifecycle.shutdown();

      expect(outcome.skipped).toBe(false);
      expect(shutdownBridgeBrowserMock).toHaveBeenCalledTimes(1);
    });

    it("detects dangling SingletonLock symlinks on POSIX without following them", async () => {
      if (process.platform === "win32") return;
      const env = makeTempCopilotHome();
      symlinkSync("/proc/12345", join(env.profileDir, "SingletonLock"));
      const lifecycle = createBridgeBrowserLifecycle({ copilotHome: env.copilotHome });

      const outcome = await lifecycle.shutdown();

      expect(outcome.skipped).toBe(false);
      expect(shutdownBridgeBrowserMock).toHaveBeenCalledTimes(1);
    });

    it("passes launch config from settingsStore through to the resolved target", async () => {
      const env = makeTempCopilotHome();
      writeFileSync(join(env.profileDir, "SingletonLock"), "");
      const lifecycle = createBridgeBrowserLifecycle({
        copilotHome: env.copilotHome,
        settingsStore: {
          getSettings: () => ({
            browser: { executablePath: "/custom/chrome" },
          }),
        },
      });

      const outcome = await lifecycle.shutdown();

      expect(outcome.skipped).toBe(false);
      const [target] = shutdownBridgeBrowserMock.mock.calls[0];
      expect(target.executablePath).toBe("/custom/chrome");
    });

    it("propagates errors from shutdownBridgeBrowser", async () => {
      const env = makeTempCopilotHome();
      writeFileSync(join(env.profileDir, "SingletonLock"), "");
      shutdownBridgeBrowserMock.mockRejectedValueOnce(new Error("close failed"));
      const lifecycle = createBridgeBrowserLifecycle({ copilotHome: env.copilotHome });

      await expect(lifecycle.shutdown()).rejects.toThrow("close failed");
    });
  });

  describe("noopBrowserLifecycle", () => {
    it("never calls shutdownBridgeBrowser", async () => {
      const outcome = await noopBrowserLifecycle.shutdown();
      expect(outcome.skipped).toBe(true);
      if (outcome.skipped) expect(outcome.reason).toBe("disabled");
      expect(shutdownBridgeBrowserMock).not.toHaveBeenCalled();
    });
  });
});
