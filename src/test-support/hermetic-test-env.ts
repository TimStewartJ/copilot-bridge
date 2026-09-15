// The live Bridge exports its runtime configuration to every process it spawns:
// BRIDGE_DATA_DIR, BRIDGE_DISTRIBUTION_MODE=release, BRIDGE_CONTROL_ROOT,
// COPILOT_HOME, service credentials, and the Copilot CLI session variables.
// Agent shells, staging validation, and deploy checks all inherit them, so a
// test process started from any of them would resolve production runtime paths
// by default (one staging_preview test snapshotted the live bridge.db) and
// behave differently than it does in CI, where none of these are set.
const AMBIENT_RUNTIME_ENV_KEY = /^(?:BRIDGE|COPILOT)[_-]/i;
const AMBIENT_CREDENTIAL_ENV_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

export function isAmbientRuntimeEnvKey(key: string): boolean {
  return AMBIENT_RUNTIME_ENV_KEY.test(key) || AMBIENT_CREDENTIAL_ENV_KEYS.has(key.toUpperCase());
}

export function scrubAmbientRuntimeEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter(isAmbientRuntimeEnvKey);
  for (const key of removed) {
    delete env[key];
  }
  return removed;
}
