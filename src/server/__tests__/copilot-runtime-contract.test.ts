import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXPECTED_RUNTIME_VERSION = "1.0.83";
const EXPECTED_SDK_VERSION = "1.0.13";

describe("installed Copilot runtime contract", () => {
  const installedApp = findInstalledStableCopilotApp();

  it("resolves the explicitly installed runtime package", () => {
    expect(
      installedApp,
      `No installed @github/copilot platform package at version ${EXPECTED_RUNTIME_VERSION}. Run \`npm install\` before the server test lane.`,
    ).toBeTruthy();
  });

  it("launches the runtime directly through the Bridge wrapper", () => {
    const wrapperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "copilot-cli-wrapper.js");
    const wrapperSource = readFileSync(wrapperPath, "utf-8");
    expect(wrapperSource).not.toContain("copilot-cli-loader");
    expect(wrapperSource).not.toContain("register(");

    const output = execFileSync(process.execPath, [wrapperPath, "--version"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        COPILOT_AUTO_UPDATE: "false",
      },
    });
    expect(output).toContain(EXPECTED_RUNTIME_VERSION);
  });
});

describe("installed Copilot SDK contract", () => {
  const sdkPackageJsonPath = findInstalledSdkFile("package.json");
  const rpcTypesPath = findInstalledSdkFile(join("dist", "generated", "rpc.d.ts"));

  it("uses the native SDK release without a runtime dependency", () => {
    expect(sdkPackageJsonPath, "No installed @github/copilot-sdk package.json found.").toBeTruthy();
    const packageJson = JSON.parse(readFileSync(sdkPackageJsonPath!, "utf-8")) as {
      version?: string;
      dependencies?: Record<string, string>;
    };
    expect(packageJson.version).toBe(EXPECTED_SDK_VERSION);
    expect(packageJson.dependencies).not.toHaveProperty("@github/copilot");
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

function findInstalledStableCopilotApp(): { appPath: string; packageDir: string } | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("copilot-") || entry.name === "copilot-sdk") continue;
    const packageDir = join(scopeDir, entry.name);
    const packageJsonPath = join(packageDir, "package.json");
    const appPath = join(packageDir, "app.js");
    if (!existsSync(packageJsonPath) || !existsSync(appPath)) continue;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: string };
    if (packageJson.version === EXPECTED_RUNTIME_VERSION) return { appPath, packageDir };
  }
  return undefined;
}

function findInstalledSdkFile(relativePath: string): string | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  const candidate = join(scopeDir, "copilot-sdk", relativePath);
  return existsSync(candidate) ? candidate : undefined;
}
