import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBridgeChildEnv, loadBridgeEnv, loadBridgeEnvManagedKeys } from "../env-loader.js";

const TEST_KEYS = [
  "BRIDGE_TEST_ENV_ONLY",
  "BRIDGE_TEST_ENV_OVERRIDE",
  "BRIDGE_TEST_ENV_REFRESH",
] as const;

beforeEach(() => {
  for (const key of TEST_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      vi.stubEnv("BRIDGE_TEST_ENV_OVERRIDE", "from-process");

      expect(loadBridgeEnv(envPath)).toEqual([]);
      expect(process.env.BRIDGE_TEST_ENV_OVERRIDE).toBe("from-process");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the .env file is missing", () => {
    const envPath = join(tmpdir(), "bridge-env-missing", ".env");
    vi.stubEnv("BRIDGE_TEST_ENV_ONLY", undefined);

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

  it("tracks file keys as managed when a wrapper preloaded them into launcher env", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-env-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "BRIDGE_TEST_ENV_REFRESH=from-file-one\n");

      const launcherEnv: NodeJS.ProcessEnv = { BRIDGE_TEST_ENV_REFRESH: "from-wrapper" };
      const managedKeys = loadBridgeEnvManagedKeys(envPath, launcherEnv);
      expect(managedKeys).toEqual(["BRIDGE_TEST_ENV_REFRESH"]);
      expect(launcherEnv.BRIDGE_TEST_ENV_REFRESH).toBe("from-wrapper");

      writeFileSync(envPath, "BRIDGE_TEST_ENV_REFRESH=from-file-two\n");
      const childEnv = buildBridgeChildEnv(launcherEnv, managedKeys, envPath);
      expect(childEnv.BRIDGE_TEST_ENV_REFRESH).toBe("from-file-two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes keys newly added to the .env file after launcher startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-env-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "");

      const launcherEnv: NodeJS.ProcessEnv = { BRIDGE_TEST_ENV_REFRESH: "from-launcher-default" };
      const managedKeys = loadBridgeEnvManagedKeys(envPath, launcherEnv);
      expect(managedKeys).toEqual([]);

      writeFileSync(envPath, "BRIDGE_TEST_ENV_REFRESH=from-file-two\n");
      const childEnv = buildBridgeChildEnv(launcherEnv, managedKeys, envPath);
      expect(childEnv.BRIDGE_TEST_ENV_REFRESH).toBe("from-file-two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets the launcher pin env keys that require a full launcher restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-env-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "BRIDGE_TEST_ENV_REFRESH=from-file\n");

      const childEnv = buildBridgeChildEnv(
        { BRIDGE_TEST_ENV_REFRESH: "from-launcher-default" },
        [],
        envPath,
        { BRIDGE_TEST_ENV_REFRESH: "from-launcher-owned" },
      );
      expect(childEnv.BRIDGE_TEST_ENV_REFRESH).toBe("from-launcher-owned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
