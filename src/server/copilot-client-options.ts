import type { CopilotClientOptions } from "@github/copilot-sdk";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";

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
): CopilotClientOptions | undefined {
  const gitHubToken = resolveBridgeCopilotGitHubToken(clientEnv);
  if (!clientEnv && !gitHubToken) return undefined;

  return {
    ...(clientEnv ? { env: clientEnv } : {}),
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
  };
}
