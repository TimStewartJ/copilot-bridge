import { constants, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestDir } from "./helpers.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

type BrowserLaunchHost = typeof import("../browser-launch-host.js");

/**
 * The real module: src/test-support/vitest-setup.ts replaces it for every other test file.
 * With a platform, forces that platform's branch; the process the POSIX branch starts is mocked
 * above, and the Windows branch only lists a folder.
 */
async function importHost(platformName?: NodeJS.Platform): Promise<BrowserLaunchHost> {
  vi.resetModules();
  vi.doUnmock("../browser-launch-host.js");
  if (platformName) {
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      platform: () => platformName,
    }));
  }
  return import("../browser-launch-host.js");
}

/** Answers `<browser> --version` with what the browser prints. */
function browserPrints(stdout: string): void {
  execFileMock.mockImplementation((
    _file: string,
    _args: string[],
    _options: unknown,
    cb: (error: unknown, result?: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr: "" });
    return {} as any;
  });
}

beforeEach(() => {
  execFileMock.mockReset();
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.doUnmock("node:fs/promises");
});

describe("readBrowserVersion", () => {
  it.each([
    ["Google Chrome 154.0.8037.97 \n", "Google Chrome 154.0.8037.97"],
    // A build may add a channel word after the number.
    ["Google Chrome 154.0.8037.97 unknown\n", "Google Chrome 154.0.8037.97"],
    ["Chromium 140.0.7339.80 built on Debian GNU/Linux 13 (trixie)\n", "Chromium 140.0.7339.80"],
    ["Google Chrome for Testing 141.0.7390.37 \n", "Google Chrome for Testing 141.0.7390.37"],
    ["  Google Chrome 154.0.8037.97\r\n", "Google Chrome 154.0.8037.97"],
  ])("reads the name and the number from %j", async (stdout, expected) => {
    browserPrints(stdout);
    const host = await importHost("linux");
    const executable = path.join(makeTestDir("browser-version"), "chrome");

    await expect(host.readBrowserVersion(executable)).resolves.toBe(expected);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe(executable);
    expect(args).toEqual(["--version"]);
    // A browser that opens a window instead of answering must not hold the caller up.
    expect(options).toMatchObject({ timeout: 5_000 });
  });

  it("skips what a wrapper script prints before the browser's own line", async () => {
    browserPrints("Gtk-Message: Failed to load module\nGoogle Chrome 154.0.8037.97 unknown\n");
    const host = await importHost("linux");

    await expect(host.readBrowserVersion(path.join(makeTestDir("browser-version-noise"), "chrome")))
      .resolves.toBe("Google Chrome 154.0.8037.97");
  });

  it.each([
    ["prints nothing", ""],
    ["prints no version number", "usage: browser [options]\n"],
  ])("has no version for a browser that %s", async (_name, stdout) => {
    browserPrints(stdout);
    const host = await importHost("linux");

    await expect(host.readBrowserVersion(path.join(makeTestDir("browser-version-none"), "chrome")))
      .resolves.toBeUndefined();
  });

  it("has no version for a browser that cannot be run", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, cb: (error: unknown) => void) => {
      cb(Object.assign(new Error("spawn chrome ENOENT"), { code: "ENOENT" }));
      return {} as any;
    });
    const host = await importHost("linux");

    await expect(host.readBrowserVersion(path.join(makeTestDir("browser-version-missing"), "chrome")))
      .resolves.toBeUndefined();
  });

  describe("on Windows", () => {
    function installFolder(names: string[]): string {
      const application = path.join(makeTestDir("browser-version-windows"), "Application");
      mkdirSync(application);
      for (const name of names) mkdirSync(path.join(application, name));
      writeFileSync(path.join(application, "chrome.exe"), "");
      return path.join(application, "chrome.exe");
    }

    it("takes the version from the folder next to the executable, without starting the browser", async () => {
      const executable = installFolder(["154.0.8037.97", "SetupMetrics", "Dictionaries"]);
      const host = await importHost("win32");

      await expect(host.readBrowserVersion(executable)).resolves.toBe("154.0.8037.97");
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("takes the highest version when an update left the previous one in place", async () => {
      const executable = installFolder(["99.0.4844.84", "154.0.8037.97", "154.0.8037.100", "100.0.4896.60"]);
      const host = await importHost("win32");

      await expect(host.readBrowserVersion(executable)).resolves.toBe("154.0.8037.100");
    });

    it("has no version when no folder is named like one or the folder is gone", async () => {
      const host = await importHost("win32");

      await expect(host.readBrowserVersion(installFolder(["SetupMetrics", "154.0", "new_154.0.8037.97"])))
        .resolves.toBeUndefined();
      await expect(host.readBrowserVersion(path.join(makeTestDir("browser-version-gone"), "Application", "chrome.exe")))
        .resolves.toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});

describe("isExecutableFile", () => {
  it("accepts a file the host can run and rejects a folder or a missing file", async () => {
    const directory = makeTestDir("browser-executable");
    const host = await importHost();

    // The one program that is certainly installed and runnable on the host of this test.
    await expect(host.isExecutableFile(process.execPath)).resolves.toBe(true);
    await expect(host.isExecutableFile(directory)).resolves.toBe(false);
    await expect(host.isExecutableFile(path.join(directory, "missing"))).resolves.toBe(false);
  });

  /** Lets a file exist for the host but not be executable, whatever the real host makes of its mode. */
  async function importHostWhereNothingIsExecutable(platformName: NodeJS.Platform) {
    const access = vi.fn(async (_file: string, mode?: number) => {
      if (mode === constants.X_OK) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    vi.doMock("node:fs/promises", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs/promises")>()),
      access,
    }));
    return { host: await importHost(platformName), access };
  }

  it("asks for the right to execute on POSIX", async () => {
    const file = path.join(makeTestDir("browser-executable-posix"), "notes.txt");
    writeFileSync(file, "");
    const { host, access } = await importHostWhereNothingIsExecutable("linux");

    await expect(host.isExecutableFile(file)).resolves.toBe(false);
    expect(access).toHaveBeenCalledWith(file, constants.X_OK);
  });

  it("asks only whether the file exists on Windows, which has no execute bit", async () => {
    const file = path.join(makeTestDir("browser-executable-windows"), "chrome.exe");
    writeFileSync(file, "");
    const { host, access } = await importHostWhereNothingIsExecutable("win32");

    await expect(host.isExecutableFile(file)).resolves.toBe(true);
    expect(access).toHaveBeenCalledWith(file, constants.F_OK);
  });
});

describe("readJsonFile", () => {
  it("returns what the file holds", async () => {
    const file = path.join(makeTestDir("browser-config"), "config.json");
    writeFileSync(file, JSON.stringify({ args: ["--no-sandbox"], headed: false }));
    const host = await importHost();

    await expect(host.readJsonFile(file)).resolves.toEqual({ args: ["--no-sandbox"], headed: false });
  });

  it("returns nothing for a file that is missing or is not JSON", async () => {
    const directory = makeTestDir("browser-config-broken");
    writeFileSync(path.join(directory, "config.json"), "{ args: --no-sandbox");
    const host = await importHost();

    await expect(host.readJsonFile(path.join(directory, "config.json"))).resolves.toBeUndefined();
    await expect(host.readJsonFile(path.join(directory, "missing.json"))).resolves.toBeUndefined();
  });
});

describe("readModifiedAt", () => {
  it("returns when the file was last replaced", async () => {
    const file = path.join(makeTestDir("browser-modified"), "chrome");
    writeFileSync(file, "");
    const replacedAt = new Date("2026-03-10T12:00:00Z");
    utimesSync(file, replacedAt, replacedAt);
    const host = await importHost();

    await expect(host.readModifiedAt(file)).resolves.toBe(replacedAt.getTime());
  });

  it("returns nothing for a file that is missing", async () => {
    const host = await importHost();

    await expect(host.readModifiedAt(path.join(makeTestDir("browser-modified-missing"), "chrome"))).resolves.toBeUndefined();
  });
});
