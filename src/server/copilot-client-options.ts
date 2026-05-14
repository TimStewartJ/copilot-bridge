import type { CopilotClientOptions } from "@github/copilot-sdk";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildCopilotClientOptions(
  clientEnv?: Record<string, string | undefined>,
): CopilotClientOptions | undefined {
  const gitHubToken = normalizeOptionalEnvValue(
    clientEnv?.[BRIDGE_COPILOT_GITHUB_TOKEN_ENV] ?? process.env[BRIDGE_COPILOT_GITHUB_TOKEN_ENV],
  );
  if (!clientEnv && !gitHubToken) return undefined;

  return {
    ...(clientEnv ? { env: clientEnv } : {}),
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
  };
}
