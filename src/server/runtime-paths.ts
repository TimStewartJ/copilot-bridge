import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import { resolveBridgeDistribution, type BridgeDistributionMode } from "./distribution-mode.js";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));

export interface RuntimePaths {
  distributionMode?: BridgeDistributionMode;
  dataDir: string;
  docsDir: string;
  docsSnapshotsDir?: string;
  copilotHome?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}

export interface RuntimePathOverrides {
  distributionMode?: BridgeDistributionMode;
  dataDir?: string;
  docsDir?: string;
  docsSnapshotsDir?: string;
  copilotHome?: string;
  workspaceDir?: string;
}

export function resolveDefaultReleaseDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CopilotBridge", "data");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "CopilotBridge", "data");
  }
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "CopilotBridge", "data");
}

/**
 * Working directory for sessions without a project folder. It sits beside the per-user
 * release data directory in every distribution mode, because the development data
 * directory lives inside the Bridge checkout and would inherit its repository instructions.
 */
export function resolveDefaultWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  return join(dirname(resolveDefaultReleaseDataDir(env, platform)), "workspace");
}

function optionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: RuntimePathOverrides = {},
): RuntimePaths {
  const distributionMode = overrides.distributionMode ?? resolveBridgeDistribution(env, REPO_ROOT).mode;
  const releaseMode = distributionMode === "release";
  const dataDir = optionalEnvValue(overrides.dataDir)
    ?? optionalEnvValue(env.BRIDGE_DATA_DIR)
    ?? (releaseMode ? resolveDefaultReleaseDataDir(env) : join(REPO_ROOT, "data"));
  const docsDir = optionalEnvValue(overrides.docsDir) ?? optionalEnvValue(env.BRIDGE_DOCS_DIR) ?? join(dataDir, "docs");
  const docsSnapshotsDir = optionalEnvValue(overrides.docsSnapshotsDir)
    ?? optionalEnvValue(env.BRIDGE_DOCS_SNAPSHOTS_DIR)
    ?? join(dataDir, "backups", "docs", "snapshots");
  const copilotHome = overrides.copilotHome
    ?? optionalEnvValue(env.COPILOT_HOME)
    ?? (releaseMode ? join(dataDir, ".copilot") : undefined);
  const workspaceDir = optionalEnvValue(overrides.workspaceDir)
    ?? optionalEnvValue(env.BRIDGE_WORKSPACE_DIR)
    ?? resolveDefaultWorkspaceDir(env);

  return {
    distributionMode,
    dataDir,
    docsDir,
    docsSnapshotsDir,
    copilotHome,
    workspaceDir,
    env: withNonInteractiveCommandEnv({
      ...env,
      BRIDGE_DISTRIBUTION_MODE: distributionMode,
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_DOCS_DIR: docsDir,
      BRIDGE_DOCS_SNAPSHOTS_DIR: docsSnapshotsDir,
      BRIDGE_WORKSPACE_DIR: workspaceDir,
      ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}),
    }),
  };
}
