import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBridgeChildEnv, loadBridgeEnv } from "../env-loader.js";

const TEST_KEYS = [
  "BRIDGE_TEST_ENV_ONLY",
  "BRIDGE_TEST_ENV_OVERRIDE",
  "BRIDGE_TEST_ENV_REFRESH",
] as const;

const originalEnv = new Map<string, string | undefined>(
  TEST_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of TEST_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("loadBridgeEnv", () => {
  it("loads values from an explicit .env path", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-env-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "BRIDGE_TEST_ENV_ONLY=loaded-from-file\n");

      expect(loadBridgeEnv(envPath)).toEqual(["BRIDGE_TEST_ENV_ONLY"]);
      expect(process.env.BRIDGE_TEST_ENV_ONLY).toBe("loaded-from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps existing environment variables over file values", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-env-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "BRIDGE_TEST_ENV_OVERRIDE=from-file\n");
      process.env.BRIDGE_TEST_ENV_OVERRIDE = "from-process";

      expect(loadBridgeEnv(envPath)).toEqual([]);
      expect(process.env.BRIDGE_TEST_ENV_OVERRIDE).toBe("from-process");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the .env file is missing", () => {
    const envPath = join(tmpdir(), "bridge-env-missing", ".env");
    delete process.env.BRIDGE_TEST_ENV_ONLY;

    expect(loadBridgeEnv(envPath)).toEqual([]);
    expect(process.env.BRIDGE_TEST_ENV_ONLY).toBeUndefined();
  });

  it("refreshes launcher-managed keys from the current .env file for child processes", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-env-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "BRIDGE_TEST_ENV_REFRESH=from-file-one\n");

      const launcherEnv: NodeJS.ProcessEnv = {};
      const managedKeys = loadBridgeEnv(envPath, launcherEnv);
      expect(launcherEnv.BRIDGE_TEST_ENV_REFRESH).toBe("from-file-one");

      writeFileSync(envPath, "BRIDGE_TEST_ENV_REFRESH=from-file-two\n");
      const childEnv = buildBridgeChildEnv(launcherEnv, managedKeys, envPath);
      expect(childEnv.BRIDGE_TEST_ENV_REFRESH).toBe("from-file-two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
