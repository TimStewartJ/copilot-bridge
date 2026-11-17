import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessHost, resetProcessHostForTests, resolveWorkerEntry } from "../process-host.js";

// What the Bridge adds to spawn-offthread: one process-wide host and how its backend is chosen.

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetProcessHostForTests();
});

describe("Bridge process host", () => {
  it("lets BRIDGE_PROCESS_HOST choose the backend and ignores any other value", async () => {
    expect(getProcessHost().mode).toBe("inline");
    for (const [configured, expected] of [["worker", "worker"], ["inline", "inline"], ["threads", "inline"]] as const) {
      await resetProcessHostForTests();
      vi.stubEnv("BRIDGE_PROCESS_HOST", configured);
      expect(getProcessHost().mode, configured).toBe(expected);
    }
  });

  it("uses the worker backend outside test suites", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(getProcessHost().mode).toBe("worker");
  });

  it("keeps one process-wide host until it is reset", async () => {
    const host = getProcessHost();
    expect(getProcessHost()).toBe(host);
    await resetProcessHostForTests();
    expect(getProcessHost()).not.toBe(host);
  });

  it("finds the server's worker modules beside this module by default", () => {
    const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    expect(resolveWorkerEntry("cli-session-store-worker").entry).toBe(join(serverDir, "cli-session-store-worker.ts"));
    expect(resolveWorkerEntry("worker", import.meta.url).entry).toBe(join(serverDir, "__tests__", "worker.ts"));
    expect(resolveWorkerEntry("cli-session-store-worker").execArgv).toEqual(["--import", expect.stringMatching(/^file:.*tsx/)]);
  });

  it.each(["cli-session-store-worker", "windows-process-table-worker"])(
    "loads %s from source, where a worker thread's own imports get no .js-to-.ts mapping",
    async (name) => {
      const { entry, execArgv } = resolveWorkerEntry(name);
      const worker = new Worker(entry, { execArgv });
      const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
      const error = await new Promise<Error | undefined>((resolve) => {
        worker.once("error", resolve);
        void exit.then(() => resolve(undefined));
      });
      expect(error?.message).toBeUndefined();
      expect(await exit).toBe(0);
    },
  );

  it("keeps what a host from before the move imports from the old worker path when it runs inline", async () => {
    const legacy = await import("../process-host-worker.js");
    expect(Object.keys(legacy).sort()).toEqual(
      ["execToOutcome", "forkOnCallingThread", "removeTreeOnCallingThread", "spawnOnCallingThread"],
    );
  });
});
