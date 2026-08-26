import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";

export interface ValidationCommandEnv {
  env: NodeJS.ProcessEnv;
  rootDir: string;
  dataDir: string;
  docsDir: string;
  docsSnapshotsDir: string;
  copilotHome: string;
  cleanup: () => void;
}

interface ValidationCommandEnvOptions {
  nodeDir?: string;
  prefix?: string;
}

const CLEANUP_MAX_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 25;

function resolvePathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

export function prependNodePath(baseEnv: NodeJS.ProcessEnv, nodeDir: string): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const pathKey = resolvePathKey(env);
  const currentPath = env[pathKey] ?? "";
  env[pathKey] = `${nodeDir}${delimiter}${currentPath}`;
  if (pathKey !== "PATH") {
    env.PATH = env[pathKey];
  }
  return env;
}

export function createValidationCommandEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: ValidationCommandEnvOptions = {},
): ValidationCommandEnv {
  const rootDir = mkdtempSync(join(tmpdir(), options.prefix ?? "bridge-validation-"));
  const dataDir = join(rootDir, "data");
  const docsDir = join(rootDir, "docs");
  const docsSnapshotsDir = join(rootDir, "docs-snapshots");
  const copilotHome = join(rootDir, ".copilot");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(docsSnapshotsDir, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });

  const env = withNonInteractiveCommandEnv(options.nodeDir
    ? prependNodePath(baseEnv, options.nodeDir)
    : { ...baseEnv });
  env.BRIDGE_DATA_DIR = dataDir;
  env.BRIDGE_DOCS_DIR = docsDir;
  env.BRIDGE_DOCS_SNAPSHOTS_DIR = docsSnapshotsDir;
  env.COPILOT_HOME = copilotHome;

  return {
    env,
    rootDir,
    dataDir,
    docsDir,
    docsSnapshotsDir,
    copilotHome,
    cleanup: () => rmSync(rootDir, {
      recursive: true,
      force: true,
      maxRetries: CLEANUP_MAX_RETRIES,
      retryDelay: CLEANUP_RETRY_DELAY_MS,
    }),
  };
}
