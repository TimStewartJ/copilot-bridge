import { resolve } from "node:path";

export const BRIDGE_CONTROL_ROOT_ENV = "BRIDGE_CONTROL_ROOT";

export function resolveBridgeControlRoot(
  fallbackRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env[BRIDGE_CONTROL_ROOT_ENV]?.trim();
  return configured ? resolve(configured) : fallbackRoot;
}
