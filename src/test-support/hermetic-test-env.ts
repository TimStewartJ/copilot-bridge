import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// The live Bridge exports its runtime configuration to every process it spawns:
// BRIDGE_DATA_DIR, BRIDGE_DISTRIBUTION_MODE=release, BRIDGE_CONTROL_ROOT,
// COPILOT_HOME, service credentials, and the Copilot CLI session variables.
// Agent shells, staging validation, and deploy checks all inherit them, so a
// test process started from any of them would resolve production runtime paths
// by default (one staging_preview test snapshotted the live bridge.db) and
// behave differently than it does in CI, where none of these are set.
const AMBIENT_RUNTIME_ENV_KEY = /^(?:BRIDGE|COPILOT)[_-]/i;
const AMBIENT_CREDENTIAL_ENV_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

export function isAmbientRuntimeEnvKey(key: string): boolean {
  return AMBIENT_RUNTIME_ENV_KEY.test(key) || AMBIENT_CREDENTIAL_ENV_KEYS.has(key.toUpperCase());
}

export function scrubAmbientRuntimeEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter(isAmbientRuntimeEnvKey);
  for (const key of removed) {
    delete env[key];
  }
  return removed;
}

const RUN_TEMP_PREFIX = "bridge-vitest-";
const ABANDONED_RUN_TEMP_MS = 24 * 60 * 60_000;

/**
 * Gives a test run one temp folder of its own and removes it when the run's process exits. Tests
 * and the code under them make temp folders freely, and some write after their own cleanup ran,
 * which recreates a folder nobody removes: about 414,000 of them had piled up in the system temp
 * folder. A run that was killed leaves its folder; the next run removes those older than a day.
 */
export function useRunTempDir(env: NodeJS.ProcessEnv = process.env, parent = tmpdir()): string {
  // Every project config loads its own copy of this module, and a test can start a run of its own.
  if (basename(parent).startsWith(RUN_TEMP_PREFIX)) return parent;
  const remove = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(RUN_TEMP_PREFIX)) continue;
    const dir = join(parent, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > ABANDONED_RUN_TEMP_MS) remove(dir);
    } catch {
      // Another run removed it, or still owns something in it.
    }
  }
  const dir = mkdtempSync(join(parent, RUN_TEMP_PREFIX));
  // os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on Windows.
  env.TMPDIR = env.TEMP = env.TMP = dir;
  process.once("exit", () => {
    try {
      remove(dir);
    } catch {
      // A process the run started may still hold a file open; the next run's sweep removes it.
    }
  });
  return dir;
}
