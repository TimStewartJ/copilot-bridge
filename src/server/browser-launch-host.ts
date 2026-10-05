// What browser-launch asks of the machine it runs on: which browsers are installed, what
// agent-browser's own configuration says, how old an executable is. Kept apart so that tests
// replace it (see src/test-support/vitest-setup.ts) and do not depend on their host.

import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";

import { getProcessHost } from "./process-host.js";

export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await access(file, platform() === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The parsed file, or undefined when it is missing or not JSON. */
export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/** When the file was last replaced, in epoch milliseconds. Undefined when it cannot be read. */
export async function readModifiedAt(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Chrome and Edge on Windows print nothing for `--version` and may open a window instead; the
 * installed version is the name of the folder next to the executable.
 */
async function readWindowsBrowserVersion(executablePath: string): Promise<string | undefined> {
  try {
    const versions = (await readdir(path.dirname(executablePath)))
      .filter((name) => /^\d+(\.\d+){3}$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return versions.at(-1);
  } catch {
    return undefined;
  }
}

/** What the browser says it is, such as "Google Chrome 154.0.8037.97". */
export async function readBrowserVersion(executablePath: string): Promise<string | undefined> {
  if (platform() === "win32") return readWindowsBrowserVersion(executablePath);
  try {
    const { stdout } = await getProcessHost().execFile(executablePath, ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    // The name and the number; a build may add a channel word after them.
    return stdout.match(/\S.*?\d+(\.\d+)+/)?.[0];
  } catch {
    return undefined;
  }
}
