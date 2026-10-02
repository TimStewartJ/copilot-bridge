import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessHost, resetProcessHostForTests, resolveWorkerEntry } from "../process-host.js";

// The host's mechanism is tested in src/packages/spawn-offthread. These tests cover what the
// Bridge adds: one process-wide host, and the rule for which backend it uses.

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetProcessHostForTests();
});

describe("Bridge process host", () => {
  it("creates processes on the calling thread in test suites, which mock node:child_process there", () => {
    expect(getProcessHost().mode).toBe("inline");
  });

  it("lets BRIDGE_PROCESS_HOST choose the backend and ignores any other value", async () => {
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

  it("keeps what a host from before the move imports from the old worker path when it runs inline", async () => {
    const legacy = await import("../process-host-worker.js");
    expect(Object.keys(legacy).sort()).toEqual(
      ["execToOutcome", "forkOnCallingThread", "removeTreeOnCallingThread", "spawnOnCallingThread"],
    );
  });
});
