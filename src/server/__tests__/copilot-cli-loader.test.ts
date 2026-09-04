import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { patchCopilotAppSource } from "../copilot-cli-loader.js";
import { makeTestDir } from "./helpers.js";

const STABLE_RESOLVER = `
async resolveBuiltInGitHubMcpConfig(t,n,r,o=!1){if(!this.shouldInjectBuiltInGitHubMcp(t)||t.providerPresent)return;let s=await y.githubMcpShouldExcludeGhReplaceableTools(),a=await y.userSettingsLoad({}),l=this.options.featureFlags?.FIDES_IFC??!1,c=y.githubMcpResolveToolOptionsTyped(void 0,JSON.stringify(y.githubMcpToolOptionsFromSettings(a)),r===void 0?void 0:JSON.stringify(r),l,s),d={...c,copilotIntegrationId:this.integrationId,enableMcpApps:o},u=t[Nj],p=u?y.githubTokenProviderExistingAuthInfo(u):void 0,f=p?await y.githubMcpResolveConfigForAuthInfo(p,d):await y.githubMcpResolveConfigForAuthContext(this.authManager.managerConfig(),t.authContextId,d);if(f)return{config:JSON.parse(f.configJson),userOverrode:c.userOverrode}}
`;
const STABLE_ELICITATION = `
class Host{
remoteOptions(t){return{hostSupportsElicitation:t?.requestElicitation===!0,enableElicitationCallback:t?.requestElicitation??!1}}
createOptions(t){return{hostSupportsElicitation:t.requestElicitation===!0,enableElicitationCallback:t.requestElicitation??!1}}
resumeOptions(t,n){return{hostSupportsElicitation:t.requestElicitation===!0||t.observePromptEvents===!0&&!this.extensionConnections.has(n),enableElicitationCallback:t.requestElicitation??!1}}
rpcOptions(t){return{enableElicitationCallback:t.requestElicitation??!1}}
supportsElicitation(){return m.sessionBaseSupportsCapability(this.nativeSessionId,"elicitation")}
}
`;

describe("copilot-cli-loader stable contract", () => {
  it("injects Bridge GitHub MCP options and validates native elicitation in the 1.0.81 shape", () => {
    const source = `class App{${STABLE_RESOLVER}${STABLE_ELICITATION}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain(
      "async resolveBuiltInGitHubMcpConfig(t,n,r,o=!1){const __bridgeGithubMcpOptions=t.githubMcpToolOptions;",
    );
    expect(patched).toContain(
      "if((!this.shouldInjectBuiltInGitHubMcp(t)&&!(__bridgeGithubMcpOptions&&!t.hasGitHubToken))||t.providerPresent)return;",
    );
    expect(patched).toContain(
      "d={...c,copilotIntegrationId:this.integrationId,enableMcpApps:o,...__bridgeGithubMcpOptions}",
    );
    expect(patched).toContain("hostSupportsElicitation:t.requestElicitation===!0");
    expect(patched).toContain("enableElicitationCallback:t.requestElicitation??!1");
  });

  it("fails closed when the stable bundle contract drifts", () => {
    const source = `class App{${STABLE_RESOLVER.replace("||t.providerPresent", "||t.providerPresent===!0")}${STABLE_ELICITATION}}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "expected 1 stable config resolver guard, found 0",
    );
  });

  it("fails closed when the merged GitHub MCP options stop feeding an auth resolver", () => {
    const source = `class App{${
      STABLE_RESOLVER.replace(
        "this.authManager.managerConfig(),t.authContextId,d",
        "this.authManager.managerConfig(),t.authContextId,c",
      )
    }${STABLE_ELICITATION}}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "stable config options do not feed both auth resolvers",
    );
  });

  it("fails closed when a native elicitation capability gate disappears", () => {
    const source = `class App{${STABLE_RESOLVER}${
      STABLE_ELICITATION.replace("hostSupportsElicitation:t?.requestElicitation===!0,", "")
    }}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "expected 3 stable capability gates, found 2",
    );
  });

  const installedApp = findInstalledStableCopilotApp();

  it("resolves the installed 1.0.81 platform package", () => {
    expect(
      installedApp,
      "No installed @github/copilot platform package at version 1.0.81. Run `npm install` before the server test lane.",
    ).toBeTruthy();
  });

  it("patches the installed 1.0.81 bundle and emits syntactically valid ESM", () => {
    const source = readFileSync(installedApp!.appPath, "utf-8");
    const patched = patchCopilotAppSource(source);

    expect(patched).not.toBe(source);
    expect(patched).toContain("__bridgeGithubMcpOptions");

    const dir = makeTestDir("bridge-copilot-loader-syntax-");
    const modulePath = join(dir, "patched-app.mjs");
    writeFileSync(modulePath, patched);
    expect(() => execFileSync(process.execPath, ["--check", modulePath], { stdio: "pipe" })).not.toThrow();
  });

  it("launches the installed 1.0.81 package through the Bridge wrapper", () => {
    const wrapperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "copilot-cli-wrapper.js");
    const output = execFileSync(process.execPath, [wrapperPath, "--version"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        COPILOT_AUTO_UPDATE: "false",
      },
    });

    expect(output).toContain("1.0.81");
  });
});

describe("installed @github/copilot-sdk pending-interaction contract", () => {
  const rpcTypesPath = findInstalledSdkGeneratedRpcTypes();

  it("resolves the installed generated RPC type declarations", () => {
    expect(
      rpcTypesPath,
      "No installed @github/copilot-sdk generated rpc.d.ts found. Run `npm install` before the server test lane.",
    ).toBeTruthy();
  });

  it("keeps greppable SDK transport disconnect warnings in the installed client", () => {
    const clientPath = findInstalledSdkClient();
    expect(clientPath, "No installed @github/copilot-sdk dist/client.js found.").toBeTruthy();
    const client = readFileSync(clientPath!, "utf-8");

    expect(client).toContain("JSON-RPC connection closed unexpectedly");
    expect(client).toContain("[copilot-sdk] stdin pipe error");
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
    if (packageJson.version === "1.0.81") return { appPath, packageDir };
  }
  return undefined;
}

function findInstalledSdkGeneratedRpcTypes(): string | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  const candidate = join(scopeDir, "copilot-sdk", "dist", "generated", "rpc.d.ts");
  return existsSync(candidate) ? candidate : undefined;
}

function findInstalledSdkClient(): string | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  const candidate = join(scopeDir, "copilot-sdk", "dist", "client.js");
  return existsSync(candidate) ? candidate : undefined;
}
