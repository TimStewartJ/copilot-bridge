import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";
const HYDRAFUSION_FEATURE_FLAGS = ["HYDRAFUSION", "HYDRAFUSION_ROLLOUT"];

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
  // Use the SDK's bundled runtime; the CLI app's headless host drops the HydraFusion flags.
  delete env.COPILOT_CLI_PATH;

  return {
    connection: RuntimeConnection.forStdio(),
    env,
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
  };
}
