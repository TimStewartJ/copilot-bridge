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
  if (normalized === "release" || normalized === "development") return normalized;
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

/**
 * The control distribution decides whether source management (staging, self
 * update) is available. The launcher sets BRIDGE_CONTROL_DISTRIBUTION_MODE for
 * every child it starts; a process started directly falls back to its own
 * runtime mode.
 */
export function resolveBridgeControlDistribution(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
): BridgeDistribution {
  const gitAvailable = hasGitCheckout(rootDir);
  const explicitMode = normalizeDistributionMode(env[BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV])
    ?? normalizeDistributionMode(env.BRIDGE_DISTRIBUTION_MODE);
  return {
    mode: explicitMode ?? (gitAvailable ? "development" : "release"),
    gitAvailable,
    ...(explicitMode ? { explicitMode } : {}),
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
