import { existsSync } from "node:fs";
import { join } from "node:path";

export type BridgeDistributionMode = "development" | "release";
export const BRIDGE_ACTIVE_RELEASE_ROOT_ENV = "BRIDGE_ACTIVE_RELEASE_ROOT";
export const BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV = "BRIDGE_CONTROL_DISTRIBUTION_MODE";

export interface BridgeDistribution {
  mode: BridgeDistributionMode;
  gitAvailable: boolean;
  explicitMode?: BridgeDistributionMode;
  rootDir: string;
}

function normalizeDistributionMode(value: string | undefined): BridgeDistributionMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "release" || normalized === "packaged") return "release";
  if (normalized === "development" || normalized === "dev" || normalized === "source") return "development";
  throw new Error(
    `Invalid BRIDGE_DISTRIBUTION_MODE "${value}". Expected "development" or "release".`,
  );
}

export function hasGitCheckout(rootDir: string): boolean {
  return existsSync(join(rootDir, ".git"));
}

export function resolveBridgeDistribution(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
): BridgeDistribution {
  const explicitMode = normalizeDistributionMode(env.BRIDGE_DISTRIBUTION_MODE);
  const gitAvailable = hasGitCheckout(rootDir);
  return {
    mode: explicitMode ?? (gitAvailable ? "development" : "release"),
    gitAvailable,
    ...(explicitMode ? { explicitMode } : {}),
    rootDir,
  };
}

export function isBridgeReleaseMode(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
): boolean {
  return resolveBridgeDistribution(env, rootDir).mode === "release";
}

export function resolveBridgeControlDistribution(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
): BridgeDistribution {
  const gitAvailable = hasGitCheckout(rootDir);
  const explicitMode = normalizeDistributionMode(env[BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV]);
  if (explicitMode) {
    return { mode: explicitMode, gitAvailable, explicitMode, rootDir };
  }

  const runtimeMode = normalizeDistributionMode(env.BRIDGE_DISTRIBUTION_MODE);
  const activeReleaseRoot = env[BRIDGE_ACTIVE_RELEASE_ROOT_ENV]?.trim();
  if (runtimeMode === "release" && activeReleaseRoot && gitAvailable) {
    return { mode: "development", gitAvailable, rootDir };
  }

  return {
    mode: runtimeMode ?? (gitAvailable ? "development" : "release"),
    gitAvailable,
    ...(runtimeMode ? { explicitMode: runtimeMode } : {}),
    rootDir,
  };
}

export function isBridgeSourceManagementAvailable(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
): boolean {
  const distribution = resolveBridgeControlDistribution(env, rootDir);
  return distribution.mode === "development" && distribution.gitAvailable;
}
