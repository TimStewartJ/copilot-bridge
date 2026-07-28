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

  it("refreshes launcher-managed keys from the current .env file, whether loaded or preloaded by a wrapper", () => {
    // Loaded by loadBridgeEnv: key becomes managed, child gets refreshed value
    const dir1 = mkdtempSync(join(tmpdir(), "bridge-env-"));
    try {
      const envPath1 = join(dir1, ".env");
      writeFileSync(envPath1, "BRIDGE_TEST_ENV_REFRESH=from-file-one\n");

      const launcherEnv1: NodeJS.ProcessEnv = {};
      const managedKeys1 = loadBridgeEnv(envPath1, launcherEnv1);
      expect(launcherEnv1.BRIDGE_TEST_ENV_REFRESH).toBe("from-file-one");

      writeFileSync(envPath1, "BRIDGE_TEST_ENV_REFRESH=from-file-two\n");
      const childEnv1 = buildBridgeChildEnv(launcherEnv1, managedKeys1, envPath1);
      expect(childEnv1.BRIDGE_TEST_ENV_REFRESH).toBe("from-file-two");
    } finally {
      rmSync(dir1, { recursive: true, force: true });
    }

    // Preloaded by a wrapper: key is tracked as managed and child gets refreshed value
    const dir2 = mkdtempSync(join(tmpdir(), "bridge-env-"));
    try {
      const envPath2 = join(dir2, ".env");
      writeFileSync(envPath2, "BRIDGE_TEST_ENV_REFRESH=from-file-one\n");

      const launcherEnv2: NodeJS.ProcessEnv = { BRIDGE_TEST_ENV_REFRESH: "from-wrapper" };
      const managedKeys2 = loadBridgeEnvManagedKeys(envPath2, launcherEnv2);
      expect(managedKeys2).toEqual(["BRIDGE_TEST_ENV_REFRESH"]);
      expect(launcherEnv2.BRIDGE_TEST_ENV_REFRESH).toBe("from-wrapper");

      writeFileSync(envPath2, "BRIDGE_TEST_ENV_REFRESH=from-file-two\n");
      const childEnv2 = buildBridgeChildEnv(launcherEnv2, managedKeys2, envPath2);
      expect(childEnv2.BRIDGE_TEST_ENV_REFRESH).toBe("from-file-two");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
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
