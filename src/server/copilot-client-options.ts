import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_COPILOT_APP_DIR_ENV,
  COPILOT_CLI_CODE_ROOT,
  describeCopilotCliResolution,
  resolveCopilotCliCacheDir,
  resolveCopilotCliForLaunch,
  type CopilotCliResolution,
} from "./copilot-cli-pin.js";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";
const __dirname = dirname(fileURLToPath(import.meta.url));
const COPILOT_CLI_WRAPPER_FILENAME = "copilot-cli-wrapper.js";
const BRIDGE_COPILOT_CLI_ARGS = ["--experimental"] as const;

export interface BridgeCopilotClientOptions extends CopilotClientOptions {
  cliPath: string;
  /** Which Copilot CLI build the wrapper will launch (pinned release vs npm package). */
  copilotCli: CopilotCliResolution;
}

export interface BuildCopilotClientOptionsOverrides {
  /** Code root holding copilot-cli.lock.json. Defaults to the running code tree. */
  copilotCliRootDir?: string;
  /** Cache directory for pinned CLI builds. Defaults to the env-derived location. */
  copilotCliCacheDir?: string;
}

export function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveBridgeCopilotGitHubToken(
  clientEnv?: Record<string, string | undefined>,
): string | undefined {
  return normalizeOptionalEnvValue(
    clientEnv?.[BRIDGE_COPILOT_GITHUB_TOKEN_ENV] ?? process.env[BRIDGE_COPILOT_GITHUB_TOKEN_ENV],
  );
}

export function resolveBridgeCopilotCliPath(): string {
  const localWrapper = join(__dirname, COPILOT_CLI_WRAPPER_FILENAME);
  if (existsSync(localWrapper)) return localWrapper;

  return resolve(__dirname, "..", "..", "src", "server", COPILOT_CLI_WRAPPER_FILENAME);
}

/**
 * Decide which CLI build the wrapper launches for this client. The cache
 * location comes from the same env the CLI child inherits, so a caller that
 * passes an isolated `clientEnv` (tests, disposable sessions) without a data
 * dir gets the npm package rather than a pinned build from another tree.
 */
export function resolveCopilotCliLaunch(
  env: Record<string, string | undefined>,
  overrides: BuildCopilotClientOptionsOverrides = {},
): CopilotCliResolution {
  const dataDir = normalizeOptionalEnvValue(env.BRIDGE_DATA_DIR)
    ?? join(COPILOT_CLI_CODE_ROOT, "data");
  const cacheDir = overrides.copilotCliCacheDir ?? resolveCopilotCliCacheDir(env, dataDir);
  return resolveCopilotCliForLaunch({ rootDir: overrides.copilotCliRootDir, cacheDir });
}

let lastLoggedCopilotCliLaunch: string | undefined;

export function buildCopilotClientOptions(
  clientEnv?: Record<string, string | undefined>,
  overrides: BuildCopilotClientOptionsOverrides = {},
): BridgeCopilotClientOptions {
  const gitHubToken = resolveBridgeCopilotGitHubToken(clientEnv);
  const cliPath = resolveBridgeCopilotCliPath();
  const baseEnv = clientEnv ?? process.env;
  const copilotCli = resolveCopilotCliLaunch(baseEnv, overrides);
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    COPILOT_CLI_PATH: cliPath,
  };
  if (copilotCli.source === "pinned" && copilotCli.appDir) {
    env[BRIDGE_COPILOT_APP_DIR_ENV] = copilotCli.appDir;
  } else {
    delete env[BRIDGE_COPILOT_APP_DIR_ENV];
  }
  const description = describeCopilotCliResolution(copilotCli);
  if (description !== lastLoggedCopilotCliLaunch) {
    lastLoggedCopilotCliLaunch = description;
    const logger = copilotCli.source === "npm-fallback" ? console.warn : console.log;
    logger(`[sdk] Copilot CLI launch target: ${description}`);
  }

  return {
    cliPath,
    copilotCli,
    connection: RuntimeConnection.forStdio({ path: cliPath, args: BRIDGE_COPILOT_CLI_ARGS }),
    env,
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
  };
}
