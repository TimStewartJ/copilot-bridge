import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { hasGitCheckout, resolveBridgeDistribution } from "../distribution-mode.js";

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

  it("honors explicit development mode aliases", () => {
    const rootDir = join(tmpdir(), `bridge-dev-${Date.now()}`);
    mkdirSync(rootDir, { recursive: true });

    expect(resolveBridgeDistribution({ BRIDGE_DISTRIBUTION_MODE: "dev" }, rootDir)).toMatchObject({
      mode: "development",
      explicitMode: "development",
    });
  });

  it("rejects invalid explicit modes", () => {
    expect(() => resolveBridgeDistribution({ BRIDGE_DISTRIBUTION_MODE: "banana" }, tmpdir()))
      .toThrow(/Invalid BRIDGE_DISTRIBUTION_MODE/);
  });
});
