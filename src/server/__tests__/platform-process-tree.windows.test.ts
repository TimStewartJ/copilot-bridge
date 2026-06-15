import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createDeadline } from "../deadline.js";
import {
  captureProcessIdentity,
  PROCESS_TREE_TERMINATION_BUDGET_MS,
  terminateProcessTree,
  type ProcessIdentity,
} from "../platform.js";

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("child readiness timed out")), 10_000);
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
  const identity = await captureProcessIdentity(child.pid, createDeadline(10_000));
  if (!identity) throw new Error(`could not capture child identity for PID ${child.pid}`);
  return identity;
}

describe.runIf(process.platform === "win32")("Windows process-tree integration", () => {
  it("terminates a high-churn descendant tree without touching an unrelated process", async () => {
    const leafCode = "setTimeout(() => process.exit(0), 30000)";
    const rootCode = `
      const { spawn } = require("node:child_process");
      const leaf = ${JSON.stringify(leafCode)};
      for (let index = 0; index < 8; index++) {
        spawn(process.execPath, ["-e", leaf], { stdio: "ignore" });
      }
      const churn = setInterval(() => {
        spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 25)"], { stdio: "ignore" });
      }, 10);
      setTimeout(() => clearInterval(churn), 1000);
      console.log("READY");
      setTimeout(() => process.exit(0), 30000);
    `;
    const root = spawn(process.execPath, ["-e", rootCode], {
      stdio: ["ignore", "pipe", "ignore"],
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
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await terminateProcessTree(
        rootIdentity,
        createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS),
      );

      expect(result).toMatchObject({ ok: true, status: "terminated" });
      expect(result.snapshot?.descendants.length).toBeGreaterThan(0);
      await waitForExit(root);
      expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
      expect(() => process.kill(unrelatedIdentity!.pid, 0)).not.toThrow();
    } finally {
      if (rootIdentity) {
        await terminateProcessTree(
          rootIdentity,
          createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS),
        );
      }
      if (unrelatedIdentity) {
        await terminateProcessTree(
          unrelatedIdentity,
          createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS),
        );
      }
    }
  }, 45_000);
});
