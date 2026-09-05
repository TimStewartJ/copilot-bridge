import { CopilotClient } from "@github/copilot-sdk";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRIDGE_COPILOT_GITHUB_TOKEN_ENV, buildCopilotClientOptions } from "../copilot-client-options.js";
import { makeTestDir } from "./helpers.js";
import { testExecutablePath } from "./test-paths.js";

const EXPECTED_RUNTIME_VERSION = "1.0.83";
const EXPECTED_SDK_VERSION = "1.0.13";

describe("installed Copilot runtime contract", () => {
  it("starts the SDK's bundled runtime without a CLI wrapper or external CLI installation", async () => {
    const options = buildCopilotClientOptions({
      ...process.env,
      COPILOT_HOME: makeTestDir("copilot-native-runtime"),
      COPILOT_CLI_PATH: testExecutablePath("missing-copilot-cli"),
      [BRIDGE_COPILOT_GITHUB_TOKEN_ENV]: "",
    });
    expect(options.connection).toEqual({ kind: "stdio" });
    expect(options.env).not.toHaveProperty("COPILOT_CLI_PATH");

    const client = new CopilotClient({ ...options, useLoggedInUser: false });
    try {
      await client.start();
      await expect(client.ping()).resolves.toBeDefined();
    } finally {
      await client.stop();
    }
  }, 30_000);
});

describe("installed Copilot SDK contract", () => {
  const sdkPackageJsonPath = findInstalledSdkFile("package.json");
  const rpcTypesPath = findInstalledSdkFile(join("dist", "generated", "rpc.d.ts"));

  it("pins matching SDK platform runtimes without a separate CLI dependency", () => {
    expect(sdkPackageJsonPath, "No installed @github/copilot-sdk package.json found.").toBeTruthy();
    const packageJson = JSON.parse(readFileSync(sdkPackageJsonPath!, "utf-8")) as {
      version?: string;
      copilotCliVersion?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(packageJson.version).toBe(EXPECTED_SDK_VERSION);
    expect(packageJson.copilotCliVersion).toBe(EXPECTED_RUNTIME_VERSION);
    expect(packageJson.dependencies).not.toHaveProperty("@github/copilot");
    expect(packageJson.optionalDependencies).toMatchObject({
      "@github/copilot-sdk-linux-x64": EXPECTED_SDK_VERSION,
      "@github/copilot-sdk-win32-x64": EXPECTED_SDK_VERSION,
      "@github/copilot-sdk-darwin-arm64": EXPECTED_SDK_VERSION,
    });
  });

  it("keeps the pending-interaction RPC surface explicit", () => {
    expect(
      rpcTypesPath,
      "No installed @github/copilot-sdk generated rpc.d.ts found. Run `npm install` before the server test lane.",
    ).toBeTruthy();
    const rpcTypes = readFileSync(rpcTypesPath!, "utf-8");
    expect(rpcTypes).not.toContain("pendingUserInputs");
    expect(rpcTypes).not.toContain("pendingElicitations");
  });
});

function findGithubScopeDir(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, "node_modules", "@github");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function findInstalledSdkFile(relativePath: string): string | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  const candidate = join(scopeDir, "copilot-sdk", relativePath);
  return existsSync(candidate) ? candidate : undefined;
}
