import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCopilotClientOptions,
  resolveBridgeCopilotCliPath,
  resolveCopilotCliLaunch,
} from "../copilot-client-options.js";
import {
  BRIDGE_COPILOT_APP_DIR_ENV,
  BRIDGE_COPILOT_CLI_CACHE_DIR_ENV,
  COPILOT_CLI_LOCK_FILENAME,
  getPinnedCopilotCliDir,
  PINNED_COPILOT_CLI_MARKER,
} from "../copilot-cli-pin.js";
import { makeTestDir } from "./helpers.js";

const VERSION = "1.0.81-6";
const PLATFORM = `${process.platform}-${process.arch}`;

function writePinnedLock(rootDir: string): void {
  writeFileSync(join(rootDir, COPILOT_CLI_LOCK_FILENAME), JSON.stringify({
    source: "github-release",
    version: VERSION,
    assets: { [PLATFORM]: { name: `github-copilot-${VERSION}-${PLATFORM}.tgz`, sha256: "a".repeat(64) } },
  }));
}

function installFakePinnedBuild(cacheDir: string, options: { indexSource?: string } = {}): string {
  const appDir = getPinnedCopilotCliDir(cacheDir, VERSION);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "@github/copilot", version: VERSION }));
  writeFileSync(join(appDir, "app.js"), "export {};\n");
  writeFileSync(join(appDir, "index.js"), options.indexSource ?? "export {};\n");
  writeFileSync(join(appDir, PINNED_COPILOT_CLI_MARKER), JSON.stringify({
    version: VERSION, asset: "x.tgz", sha256: "a".repeat(64), installedAt: new Date().toISOString(),
  }));
  return appDir;
}

describe("buildCopilotClientOptions Copilot CLI pinning", () => {
  it("points the wrapper at a ready pinned build and reports it", () => {
    const root = makeTestDir("client-options-pinned");
    const cacheDir = join(root, "cache");
    writePinnedLock(root);
    const appDir = installFakePinnedBuild(cacheDir);

    const options = buildCopilotClientOptions(
      { BRIDGE_DATA_DIR: join(root, "data"), [BRIDGE_COPILOT_CLI_CACHE_DIR_ENV]: cacheDir },
      { copilotCliRootDir: root },
    );

    expect(options.copilotCli).toEqual({ version: VERSION, appDir });
    expect(options.env?.[BRIDGE_COPILOT_APP_DIR_ENV]).toBe(appDir);
    expect(options.env?.COPILOT_CLI_PATH).toBe(resolveBridgeCopilotCliPath());
  });

  it("derives the cache from the client data dir when no cache override is set", () => {
    const root = makeTestDir("client-options-datadir");
    const dataDir = join(root, "data");
    writePinnedLock(root);
    const appDir = installFakePinnedBuild(join(dataDir, "copilot-cli"));

    const options = buildCopilotClientOptions({ BRIDGE_DATA_DIR: dataDir }, { copilotCliRootDir: root });

    expect(options.copilotCli.version).toBe(VERSION);
    expect(options.env?.[BRIDGE_COPILOT_APP_DIR_ENV]).toBe(appDir);
  });

  it("refuses to build client options when the pinned build is missing", () => {
    const root = makeTestDir("client-options-missing");
    writePinnedLock(root);

    expect(() => buildCopilotClientOptions(
      { BRIDGE_DATA_DIR: join(root, "data"), [BRIDGE_COPILOT_APP_DIR_ENV]: join(root, "stale") },
      { copilotCliRootDir: root },
    )).toThrow(/not ready/);
    expect(() => resolveCopilotCliLaunch({ BRIDGE_DATA_DIR: join(root, "data") }, { copilotCliRootDir: root }))
      .toThrow(/not ready/);
  });
});

describe("copilot-cli-wrapper pinned app dir", () => {
  const wrapperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "copilot-cli-wrapper.js");

  it("loads the pinned index.js when BRIDGE_COPILOT_APP_DIR is set", () => {
    const cacheDir = makeTestDir("wrapper-pinned");
    const appDir = installFakePinnedBuild(cacheDir, {
      indexSource: "process.stdout.write('pinned-index-loaded');\n",
    });

    const output = execFileSync(process.execPath, [wrapperPath], {
      env: { ...process.env, [BRIDGE_COPILOT_APP_DIR_ENV]: appDir },
      encoding: "utf-8",
      stdio: "pipe",
    });

    expect(output).toBe("pinned-index-loaded");
  });

  it("fails loudly instead of falling back when BRIDGE_COPILOT_APP_DIR is broken or unset", () => {
    const broken = makeTestDir("wrapper-broken");

    expect(() => execFileSync(process.execPath, [wrapperPath], {
      env: { ...process.env, [BRIDGE_COPILOT_APP_DIR_ENV]: broken },
      encoding: "utf-8",
      stdio: "pipe",
    })).toThrow(/does not contain the Copilot application entry points/);

    const env = { ...process.env };
    delete env[BRIDGE_COPILOT_APP_DIR_ENV];
    expect(() => execFileSync(process.execPath, [wrapperPath], {
      env,
      encoding: "utf-8",
      stdio: "pipe",
    })).toThrow(/BRIDGE_COPILOT_APP_DIR is not set/);
  });
});
