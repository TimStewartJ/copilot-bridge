import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveBridgeDistribution, type BridgeDistributionMode } from "./distribution-mode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

export interface RuntimePaths {
  distributionMode?: BridgeDistributionMode;
  demoMode: boolean;
  dataDir: string;
  docsDir: string;
  copilotHome?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}

export interface RuntimePathOverrides {
  distributionMode?: BridgeDistributionMode;
  demoMode?: boolean;
  dataDir?: string;
  docsDir?: string;
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

function optionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: RuntimePathOverrides = {},
): RuntimePaths {
  const distributionMode = overrides.distributionMode ?? resolveBridgeDistribution(env, REPO_ROOT).mode;
  const demoMode = overrides.demoMode ?? env.BRIDGE_DEMO_MODE === "true";
  const releaseMode = distributionMode === "release";
  const dataDir = optionalEnvValue(overrides.dataDir)
    ?? optionalEnvValue(env.BRIDGE_DATA_DIR)
    ?? (demoMode
      ? join(REPO_ROOT, "demo-data")
      : releaseMode
        ? resolveDefaultReleaseDataDir(env)
        : join(REPO_ROOT, "data"));
  const docsDir = optionalEnvValue(overrides.docsDir) ?? optionalEnvValue(env.BRIDGE_DOCS_DIR) ?? join(dataDir, "docs");
  const copilotHome = overrides.copilotHome
    ?? optionalEnvValue(env.COPILOT_HOME)
    ?? (demoMode || releaseMode ? join(dataDir, ".copilot") : undefined);
  const workspaceDir = overrides.workspaceDir ?? (demoMode ? join(dataDir, "workspace") : undefined);

  return {
    distributionMode,
    demoMode,
    dataDir,
    docsDir,
    copilotHome,
    workspaceDir,
    env: {
      ...env,
      BRIDGE_DISTRIBUTION_MODE: distributionMode,
      BRIDGE_DEMO_MODE: demoMode ? "true" : "false",
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_DOCS_DIR: docsDir,
      ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}),
    },
  };
}
