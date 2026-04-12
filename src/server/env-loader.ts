import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_PATH = join(__dirname, "..", "..", ".env");

export function readBridgeEnvFile(envPath = DEFAULT_ENV_PATH): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const parsed = parseEnv(readFileSync(envPath, "utf-8"));
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function loadBridgeEnv(
  envPath = DEFAULT_ENV_PATH,
  targetEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const fileEnv = readBridgeEnvFile(envPath);
  const loadedKeys: string[] = [];

  for (const [key, value] of Object.entries(fileEnv)) {
    if (targetEnv[key] !== undefined) continue;
    targetEnv[key] = value;
    loadedKeys.push(key);
  }

  return loadedKeys;
}

export function buildBridgeChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  managedKeys: Iterable<string>,
  envPath = DEFAULT_ENV_PATH,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of managedKeys) {
    delete childEnv[key];
  }
  return {
    ...readBridgeEnvFile(envPath),
    ...childEnv,
  };
}
