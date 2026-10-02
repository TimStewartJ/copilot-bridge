import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

export const BRIDGE_COPILOT_GITHUB_TOKEN_ENV = "BRIDGE_COPILOT_GITHUB_TOKEN";
const HYDRAFUSION_FEATURE_FLAGS = ["HYDRAFUSION", "HYDRAFUSION_ROLLOUT"];
const AGENT_BROWSER_IDLE_TIMEOUT_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
/**
 * An agent that drives agent-browser from its shell starts a daemon and a browser that outlive
 * the shell, the session and the Bridge. Nothing closes them, so they stayed on their last page
 * for weeks. With this in the runtime's environment such a daemon closes its browser and exits
 * after an hour without a command. A value set in the Bridge's own environment wins.
 */
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

/**
 * The runtime falls back to its own process cwd for repository instructions when a
 * session's cwd is outside any git work tree. Left to inherit the server's cwd (the Bridge
 * checkout or a release slot), every folder-less session would load the Bridge's AGENTS.md.
 */
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
    ...HYDRAFUSION_FEATURE_FLAGS,
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
