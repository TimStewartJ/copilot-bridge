import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "../control-root.js";
import {
  clearRestartPending,
  refreshRestartState,
  triggerRestartPending,
} from "../restart-controller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const testDefaultDir = join(tmpdir(), `bridge-test-restart-state-${process.pid}`);
const testDefaultPath = join(testDefaultDir, "restart-state.json");

// Resolve the real production restart-state path exactly the way the controller
// does (REPO_ROOT honors BRIDGE_CONTROL_ROOT), so the "untouched" assertion
// guards the actual at-risk directory — the live bridge — not this worktree.
// restart-controller.ts computes REPO_ROOT from join(its dir, "..", ".."); the
// equivalent from this test file (src/server/__tests__) is join(__dirname, "..", "..", "..").
const realProdPath = join(
  resolveBridgeControlRoot(join(__dirname, "..", "..", "..")),
  "data",
  "restart-state.json",
);

function snapshotProd(): string | null {
  return existsSync(realProdPath) ? readFileSync(realProdPath, "utf8") : null;
}

describe("restart-controller default path under the test runner", () => {
  afterEach(async () => {
    clearRestartPending();
    // Drain the write queue so the clear lands before the next test.
    await refreshRestartState();
    rmSync(testDefaultDir, { recursive: true, force: true });
  });

  it("writes an unconfigured restart to an isolated temp path, never the production data dir", async () => {
    const prodBefore = snapshotProd();

    triggerRestartPending();
    // refreshRestartState awaits the internal write queue before resolving.
    await refreshRestartState();

    // The redirect is in effect: the write landed in the isolated temp path.
    expect(existsSync(testDefaultPath)).toBe(true);
    // The real production restart-state (the live bridge's) is left untouched.
    expect(snapshotProd()).toBe(prodBefore);
  });
});
