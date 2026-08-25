import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_ACTIVE_RELEASE_ROOT_ENV,
  BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV,
  hasGitCheckout,
  isBridgeSourceManagementAvailable,
  resolveBridgeControlDistribution,
  resolveBridgeDistribution,
} from "../distribution-mode.js";

describe("distribution mode", () => {
  it("uses release mode when no git checkout is present", () => {
    const rootDir = join(tmpdir(), `bridge-release-${Date.now()}`);
    mkdirSync(rootDir, { recursive: true });

    expect(hasGitCheckout(rootDir)).toBe(false);
    expect(resolveBridgeDistribution({}, rootDir)).toMatchObject({
      mode: "release",
      gitAvailable: false,
    });
  });

  it("rejects invalid explicit modes and legacy aliases", () => {
    expect(() => resolveBridgeDistribution({ BRIDGE_DISTRIBUTION_MODE: "banana" }, tmpdir()))
      .toThrow(/Invalid BRIDGE_DISTRIBUTION_MODE/);
    expect(() => resolveBridgeDistribution({ BRIDGE_DISTRIBUTION_MODE: "dev" }, tmpdir()))
      .toThrow(/Invalid BRIDGE_DISTRIBUTION_MODE/);
  });

  it("uses the control distribution mode to decide source management availability", () => {
    const rootDir = join(tmpdir(), `bridge-control-dev-${Date.now()}`);
    mkdirSync(join(rootDir, ".git"), { recursive: true });

    const env = {
      BRIDGE_DISTRIBUTION_MODE: "release",
      [BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV]: "development",
    };

    expect(resolveBridgeControlDistribution(env, rootDir)).toMatchObject({
      mode: "development",
      explicitMode: "development",
      gitAvailable: true,
    });
    expect(isBridgeSourceManagementAvailable(env, rootDir)).toBe(true);
  });

  it("does not treat a release-slot runtime as source-managed without the control mode", () => {
    const rootDir = join(tmpdir(), `bridge-active-release-${Date.now()}`);
    mkdirSync(join(rootDir, ".git"), { recursive: true });

    const env = {
      BRIDGE_DISTRIBUTION_MODE: "release",
      [BRIDGE_ACTIVE_RELEASE_ROOT_ENV]: join(rootDir, "data", "releases", "active"),
    };

    expect(resolveBridgeControlDistribution(env, rootDir)).toMatchObject({
      mode: "release",
      gitAvailable: true,
    });
    expect(isBridgeSourceManagementAvailable(env, rootDir)).toBe(false);
  });

  it("does not allow source management without a control git checkout", () => {
    const rootDir = join(tmpdir(), `bridge-control-nogit-${Date.now()}`);
    mkdirSync(rootDir, { recursive: true });

    expect(isBridgeSourceManagementAvailable({
      [BRIDGE_CONTROL_DISTRIBUTION_MODE_ENV]: "development",
    }, rootDir)).toBe(false);
  });
});
