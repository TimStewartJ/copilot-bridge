import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";
import { createRequire } from "node:module";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";
const HYDRAFUSION_FEATURE_FLAGS = ["HYDRAFUSION", "HYDRAFUSION_ROLLOUT"];
const require = createRequire(import.meta.url);

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

export function buildCopilotClientOptions(
  clientEnv?: Record<string, string | undefined>,
): CopilotClientOptions {
  const gitHubToken = resolveBridgeCopilotGitHubToken(clientEnv);
  const inheritedEnv = clientEnv ?? process.env;
  const enabledFlags = new Set([
    ...(inheritedEnv.COPILOT_CLI_ENABLED_FEATURE_FLAGS ?? "").split(",").map((flag) => flag.trim()).filter(Boolean),
    ...HYDRAFUSION_FEATURE_FLAGS,
  ]);
  const env: Record<string, string | undefined> = {
    ...inheritedEnv,
    COPILOT_CLI_ENABLED_FEATURE_FLAGS: [...enabledFlags].join(","),
  };
  const copilotCliPath = require.resolve("@github/copilot/npm-loader.js");
  // Use the pinned CLI package so the Bridge can validate a CLI independently of the SDK bundle.
  delete env.COPILOT_CLI_PATH;

  return {
    connection: RuntimeConnection.forStdio({ path: copilotCliPath }),
    env,
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
  };
}
