import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";
/** Runtime enables Fusion only for its own host; SDK hosts set these gates (levels, Max). */
const COPILOT_FUSION_FEATURE_FLAGS = ["DYNAMIC_AUTO_TIERS", "HYDRAFUSION_PLAN_V2"];
const AGENT_BROWSER_IDLE_TIMEOUT_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
/** Shell-started agent-browser daemons outlive the Bridge; make them exit after an idle hour. */
export const AGENT_SHELL_BROWSER_IDLE_TIMEOUT_MS = 60 * 60_000;
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

/** Else folder-less sessions inherit the server cwd and load the Bridge's own AGENTS.md. */
function runtimeWorkingDirectory(workspaceDir: string | undefined): { workingDirectory?: string } {
  const dir = normalizeOptionalEnvValue(workspaceDir);
  if (!dir) return {};
  try {
    // Startup prepares it; recreate it if it disappeared so the spawn cannot fail on a missing cwd.
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    // Falling back to the inherited cwd would silently reload the Bridge's own instructions.
    throw new Error(`Could not prepare the Copilot runtime working directory ${dir}`, { cause: error });
  }
  return { workingDirectory: dir };
}

export function buildCopilotClientOptions(
  clientEnv?: Record<string, string | undefined>,
): CopilotClientOptions {
  const gitHubToken = resolveBridgeCopilotGitHubToken(clientEnv);
  const inheritedEnv = clientEnv ?? process.env;
  const enabledFlags = new Set([
    ...(inheritedEnv.COPILOT_CLI_ENABLED_FEATURE_FLAGS ?? "").split(",").map((flag) => flag.trim()).filter(Boolean),
    ...COPILOT_FUSION_FEATURE_FLAGS,
  ]);
  const env: Record<string, string | undefined> = {
    ...inheritedEnv,
    COPILOT_CLI_ENABLED_FEATURE_FLAGS: [...enabledFlags].join(","),
    [AGENT_BROWSER_IDLE_TIMEOUT_ENV]: normalizeOptionalEnvValue(inheritedEnv[AGENT_BROWSER_IDLE_TIMEOUT_ENV])
      ?? String(AGENT_SHELL_BROWSER_IDLE_TIMEOUT_MS),
  };
  const copilotCliPath = require.resolve("@github/copilot/npm-loader.js");
  // Use the pinned CLI package so the Bridge can validate a CLI independently of the SDK bundle.
  delete env.COPILOT_CLI_PATH;

  return {
    connection: RuntimeConnection.forStdio({ path: copilotCliPath }),
    env,
    ...runtimeWorkingDirectory(inheritedEnv.BRIDGE_WORKSPACE_DIR),
    ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
  };
}
