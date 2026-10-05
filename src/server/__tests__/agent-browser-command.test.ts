import { delimiter, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lstatSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  lstatSync: lstatSyncMock,
}));

const WINDOWS_EXECUTABLE = "agent-browser-win32-x64.exe";

/**
 * The real module (src/test-support/vitest-setup.ts replaces it for every other test file), on a
 * given platform. Paths and the PATH delimiter stay the host's, as node:path is not replaced.
 */
async function commandOn(platformName: NodeJS.Platform, pathValue: string, installed: string[] = []) {
  vi.resetModules();
  vi.doUnmock("../agent-browser-command.js");
  vi.doMock("node:os", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:os")>()),
    platform: () => platformName,
  }));
  vi.stubEnv("PATH", pathValue);
  lstatSyncMock.mockImplementation((file: string) => {
    if (!installed.includes(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return {};
  });
  return (await import("../agent-browser-command.js")).getAgentBrowserCommand();
}

beforeEach(() => {
  lstatSyncMock.mockReset();
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.unstubAllEnvs();
});

describe("getAgentBrowserCommand", () => {
  it("runs agent-browser by name, without a shell, where a launcher is an ordinary program", async () => {
    await expect(commandOn("linux", "/usr/bin")).resolves.toEqual({ file: "agent-browser", shell: false });
    expect(lstatSyncMock).not.toHaveBeenCalled();
  });

  it("on Windows runs the executable of a global npm install directly", async () => {
    const npmDirectory = resolve("tester", "AppData", "Roaming", "npm");
    const executable = join(npmDirectory, "node_modules", "agent-browser", "bin", WINDOWS_EXECUTABLE);

    await expect(commandOn("win32", [resolve("Windows"), npmDirectory].join(delimiter), [executable]))
      .resolves.toEqual({ file: executable, shell: false });
  });

  it("on Windows runs the executable of a project install, whose launcher is in node_modules/.bin", async () => {
    const modules = resolve("work", "app", "node_modules");
    const executable = join(modules, "agent-browser", "bin", WINDOWS_EXECUTABLE);

    await expect(commandOn("win32", join(modules, ".bin"), [executable]))
      .resolves.toEqual({ file: executable, shell: false });
  });

  it("on Windows leaves an install it cannot find to the command shell", async () => {
    await expect(commandOn("win32", resolve("Windows")))
      .resolves.toEqual({ file: "agent-browser", shell: true });
  });
});
