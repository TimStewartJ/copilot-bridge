import { vi } from "vitest";

// Suite load stalls waits 10-24 s; stay under the test timeout so hangs show the last assertion.
export const WAIT_FOR_DEFAULT_TIMEOUT_MS = 20_000;

type WaitOptions = number | { timeout?: number; interval?: number } | undefined;

export function withDefaultTimeout(options: WaitOptions): number | { timeout: number; interval?: number } {
  if (typeof options === "number") return options;
  return { ...options, timeout: options?.timeout ?? WAIT_FOR_DEFAULT_TIMEOUT_MS };
}

const waitFor = vi.waitFor;
const waitUntil = vi.waitUntil;
vi.waitFor = ((callback, options) => waitFor(callback, withDefaultTimeout(options))) as typeof vi.waitFor;
vi.waitUntil = ((callback, options) => waitUntil(callback, withDefaultTimeout(options))) as typeof vi.waitUntil;

// Vitest stopping a file mid koffi load aborts the run; real snapshots only in the native project.
if (process.env.BRIDGE_TEST_REAL_PROCESS_SNAPSHOTS !== "1") {
  vi.doMock("../server/windows-process-table.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../server/windows-process-table.js")>(),
    readNativeWindowsProcessTable: async () => {
      throw new Error("Native Windows process snapshots run only in the native test project");
    },
  }));
}

// agent-browser's install differs per machine and on Windows decides whether it runs via the shell.
vi.doMock("../server/agent-browser-command.js", () => ({
  getAgentBrowserCommand: () => ({ file: "agent-browser", shell: false }),
}));

// Installed browsers and agent-browser config differ per machine; tests default to none of either.
vi.doMock("../server/browser-launch-host.js", () => ({
  isExecutableFile: async () => false,
  readJsonFile: async () => undefined,
  readModifiedAt: async () => undefined,
  readBrowserVersion: async () => undefined,
  findDownloadedBrowser: async () => undefined,
}));
