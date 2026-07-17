import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDeadline,
  sleepUntilDeadline,
} from "../deadline.js";
import { terminateProcessTreeWithExternalFixpoint } from "../../launcher-process-tree-termination.js";
import {
  captureProcessIdentity,
  PROCESS_TREE_TERMINATION_BUDGET_MS,
  type ProcessIdentity,
} from "../platform.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TERMINATION_HELPER = join(ROOT, "src", "launcher-process-tree-termination-helper.ts");

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    // Generous readiness window: under heavy machine load (many processes,
    // slow process spawning) the root helper can take a while to print READY.
    const timeout = setTimeout(() => reject(new Error("child readiness timed out")), 30_000);
    child.once("error", reject);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function identityFor(child: ChildProcess): Promise<ProcessIdentity> {
  if (!child.pid) throw new Error("spawned child did not expose a PID");
  const deadline = createDeadline(60_000);
  let attempts = 0;
  do {
    attempts += 1;
    const identity = await captureProcessIdentity(child.pid, deadline);
    if (identity) return identity;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child PID ${child.pid} exited before its identity could be captured`);
    }
  } while (await sleepUntilDeadline(100, deadline));
  throw new Error(`could not capture child identity for PID ${child.pid} after ${attempts} attempts`);
}

function waitForMessage(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child message "${expected}" timed out`)), 10_000);
    const onError = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    const onMessage = (message: unknown) => {
      if (message !== expected) return;
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("message", onMessage);
      resolve();
    };
    child.once("error", onError);
    child.on("message", onMessage);
  });
}

async function requestHelperCleanup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) {
    try {
      child.send("CLEANUP");
      await waitForExit(child);
    } catch { /* fall through to direct child termination */ }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await waitForExit(child);
  }
}

describe.runIf(process.platform === "win32")("Windows process-tree integration", () => {
  it("terminates a high-churn descendant tree without touching an unrelated process", async () => {
    // Long-lived leaf/root helpers (5 min) so the persistent processes do not
    // self-exit during a slow run on a heavily loaded host. The assertions rely
    // on the "unrelated" process still being alive and the root only exiting
    // because it was terminated — not because a short self-exit timer fired.
    const leafCode = "setTimeout(() => process.exit(0), 300000)";
    const rootCode = `
      const { spawn } = require("node:child_process");
      const leaf = ${JSON.stringify(leafCode)};
      const leaves = [];
      for (let index = 0; index < 8; index++) {
        leaves.push(spawn(process.execPath, ["-e", leaf], { stdio: "ignore" }));
      }
      let churn;
      process.on("message", (message) => {
        if (message === "START_CHURN" && !churn) {
          churn = setInterval(() => {
            spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 25)"], { stdio: "ignore" });
          }, 10);
          setTimeout(() => {
            clearInterval(churn);
            churn = undefined;
          }, 1000);
          process.send?.("CHURNING");
        }
        if (message === "CLEANUP") {
          if (churn) clearInterval(churn);
          for (const child of leaves) child.kill();
          process.exit(0);
        }
      });
      console.log("READY");
      setTimeout(() => process.exit(0), 300000);
    `;
    const root = spawn(process.execPath, ["-e", rootCode], {
      stdio: ["ignore", "pipe", "ignore", "ipc"],
      windowsHide: true,
    });
    const unrelated = spawn(process.execPath, ["-e", leafCode], {
      stdio: "ignore",
      windowsHide: true,
    });

    let rootIdentity: ProcessIdentity | null = null;
    let unrelatedIdentity: ProcessIdentity | null = null;
    try {
      await waitForReady(root);
      rootIdentity = await identityFor(root);
      unrelatedIdentity = await identityFor(unrelated);
      const churnStarted = waitForMessage(root, "CHURNING");
      root.send("START_CHURN");
      await churnStarted;
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await terminateProcessTreeWithExternalFixpoint(
        rootIdentity,
        createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS),
        {
          command: process.execPath,
          args: [TSX_CLI, TERMINATION_HELPER],
          cwd: ROOT,
        },
      );

      expect(result.ok).toBe(true);
      expect(["terminated", "already-exited"]).toContain(result.status);
      expect(result.snapshot?.descendants.length).toBeGreaterThan(0);
      await waitForExit(root);
      expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
      expect(() => process.kill(unrelatedIdentity!.pid, 0)).not.toThrow();
    } finally {
      await requestHelperCleanup(root);
      unrelated.kill();
      await waitForExit(unrelated);
    }
  }, 180_000);
});
