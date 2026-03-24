// Shared test helpers — temp data dir setup/teardown

import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Create an isolated temp data directory and set BRIDGE_DATA_DIR.
 * Returns the path. Call `cleanupDataDir` in afterEach/afterAll.
 */
export function setupDataDir(): string {
  const dir = join(tmpdir(), `bridge-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  process.env.BRIDGE_DATA_DIR = dir;
  return dir;
}

export function cleanupDataDir(dir: string): void {
  delete process.env.BRIDGE_DATA_DIR;
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
