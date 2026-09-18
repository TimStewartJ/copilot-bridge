import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXPECTED_CLI_VERSION = "1.0.86";
const EXPECTED_SDK_VERSION = "1.0.14";

// Launching the pinned CLI lives in copilot-cli-launch.native.test.ts.
describe("installed Copilot package contract", () => {
  const sdkPackageJsonPath = findInstalledSdkFile("package.json");
  const cliPackageJsonPath = findInstalledCliFile("package.json");
  const rpcTypesPath = findInstalledSdkFile(join("dist", "generated", "rpc.d.ts"));

  it("pins the stable SDK and latest CLI package", () => {
    expect(sdkPackageJsonPath, "No installed @github/copilot-sdk package.json found.").toBeTruthy();
    expect(cliPackageJsonPath, "No installed @github/copilot package.json found.").toBeTruthy();
    const packageJson = JSON.parse(readFileSync(sdkPackageJsonPath!, "utf-8")) as {
      version?: string;
      copilotCliVersion?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const cliPackageJson = JSON.parse(readFileSync(cliPackageJsonPath!, "utf-8")) as {
      version?: string;
    };
    expect(packageJson.version).toBe(EXPECTED_SDK_VERSION);
    expect(cliPackageJson.version).toBe(EXPECTED_CLI_VERSION);
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

function findInstalledCliFile(relativePath: string): string | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  const candidate = join(scopeDir, "copilot", relativePath);
  return existsSync(candidate) ? candidate : undefined;
}
