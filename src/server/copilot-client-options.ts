import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";
const __dirname = dirname(fileURLToPath(import.meta.url));
const COPILOT_CLI_WRAPPER_FILENAME = "copilot-cli-wrapper.js";
const BRIDGE_COPILOT_CLI_ARGS = ["--experimental"] as const;

export interface BridgeCopilotClientOptions extends CopilotClientOptions {
  cliPath: string;
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

export function buildCopilotClientOptions(
  clientEnv?: Record<string, string | undefined>,
): BridgeCopilotClientOptions {
  const gitHubToken = resolveBridgeCopilotGitHubToken(clientEnv);
  const cliPath = resolveBridgeCopilotCliPath();
  const env = {
    ...(clientEnv ?? process.env),
    COPILOT_CLI_PATH: cliPath,
  };

  return {
    cliPath,
    connection: RuntimeConnection.forStdio({ path: cliPath, args: BRIDGE_COPILOT_CLI_ARGS }),
    env,
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
  };
}
