import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Strip the live Bridge's exported env (BRIDGE_*, COPILOT_*, tokens) so tests never hit prod paths.
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

/** Per-run temp dir removed on exit (tests leak dirs); later runs clear killed runs' old dirs. */
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

/** Code falling back to os.homedir() would otherwise write the real ~/.copilot. */
export function useRunHomeDir(runTempDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = join(runTempDir, "home");
  mkdirSync(home, { recursive: true });
  env.HOME = env.USERPROFILE = home;
  return home;
}
