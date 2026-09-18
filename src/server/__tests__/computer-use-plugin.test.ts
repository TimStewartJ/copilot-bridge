import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveComputerUsePlugin } from "../computer-use-plugin.js";
import { makeTestDir } from "./helpers.js";

function makePackageRoot(manifest?: string): string {
  const packageRoot = makeTestDir("computer-use-plugin");
  if (manifest !== undefined) {
    const manifestDir = join(packageRoot, "plugins", "computer-use", ".plugin");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "plugin.json"), manifest);
  }
  return packageRoot;
}

describe("resolveComputerUsePlugin", () => {
  it("returns the plugin directory and version from the SDK platform package", () => {
    const packageRoot = makePackageRoot(JSON.stringify({ name: "computer-use", version: "0.1.88" }));
    const requested: string[] = [];

    const status = resolveComputerUsePlugin({
      platform: "win32",
      arch: "x64",
      resolvePackageRoot: (packageName) => {
        requested.push(packageName);
        return packageRoot;
      },
    });

    expect(requested).toEqual(["@github/copilot-sdk-win32-x64"]);
    expect(status).toEqual({
      available: true,
      pluginDirectory: join(packageRoot, "plugins", "computer-use"),
      version: "0.1.88",
    });
  });

  it("falls back to the musl package on Linux", () => {
    const packageRoot = makePackageRoot(JSON.stringify({ name: "computer-use" }));

    const status = resolveComputerUsePlugin({
      platform: "linux",
      arch: "arm64",
      resolvePackageRoot: (packageName) =>
        packageName === "@github/copilot-sdk-linuxmusl-arm64" ? packageRoot : undefined,
    });

    expect(status).toEqual({
      available: true,
      pluginDirectory: join(packageRoot, "plugins", "computer-use"),
    });
  });

  it("names the missing platform package", () => {
    const status = resolveComputerUsePlugin({
      platform: "darwin",
      arch: "arm64",
      resolvePackageRoot: () => undefined,
    });

    expect(status).toEqual({
      available: false,
      reason: "The Copilot SDK platform package (@github/copilot-sdk-darwin-arm64) is not installed.",
    });
  });

  it("reports a platform package that ships without the plugin", () => {
    const status = resolveComputerUsePlugin({
      platform: "win32",
      arch: "x64",
      resolvePackageRoot: () => makePackageRoot(),
    });

    expect(status).toEqual({
      available: false,
      reason: "@github/copilot-sdk-win32-x64 does not include the Computer Use plugin.",
    });
  });

  it("rejects a manifest for another plugin or one it cannot parse", () => {
    const other = resolveComputerUsePlugin({
      platform: "win32",
      arch: "x64",
      resolvePackageRoot: () => makePackageRoot(JSON.stringify({ name: "something-else" })),
    });
    const broken = resolveComputerUsePlugin({
      platform: "win32",
      arch: "x64",
      resolvePackageRoot: () => makePackageRoot("{not json"),
    });

    expect(other.available).toBe(false);
    expect(other.reason).toContain("does not describe the computer-use plugin");
    expect(broken.available).toBe(false);
    expect(broken.reason).toContain("could not be read");
  });
});
