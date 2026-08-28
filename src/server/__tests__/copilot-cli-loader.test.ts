import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { patchCopilotAppSource } from "../copilot-cli-loader.js";
import { makeTestDir } from "./helpers.js";

const STABLE_RESOLVER = `
async resolveBuiltInGitHubMcpConfig(t,e,o){if(!this.shouldInjectBuiltInGitHubMcp(t)||!e||t.provider)return;let n={},l={userOverrode:!1};return{config:r(o,e,{mode:"stable"},n),userOverrode:l.userOverrode}}
`;
const STABLE_ELICITATION = `
class Host{
select(e){let u=!!e.requestUserInput,c=!!e.featureFlags?.ASK_USER_ELICITATION&&!!e.requestElicitation;return{u,c}}
callback(t){return{requestElicitation:t.toolConfig.enableRequestElicitation?()=>1:void 0}}
supportsElicitation(){return m.sessionCapabilitiesEffectiveHas(this.nativeSessionId,"elicitation")}
}
`;

describe("copilot-cli-loader stable contract", () => {
  it("injects Bridge GitHub MCP options and enables native elicitation in the 1.0.80 shape", () => {
    const source = `class App{${STABLE_RESOLVER}${STABLE_ELICITATION}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain(
      "async resolveBuiltInGitHubMcpConfig(t,e,o){const __bridgeGithubMcpOptions=t.githubMcpToolOptions;",
    );
    expect(patched).toContain(
      "if((!this.shouldInjectBuiltInGitHubMcp(t)&&!(__bridgeGithubMcpOptions&&!t.gitHubToken))||!e||t.provider)return;",
    );
    expect(patched).toContain('{mode:"stable",...__bridgeGithubMcpOptions}');
    expect(patched).toContain("let u=!!e.requestUserInput,c=!!e.requestElicitation;");
    expect(patched).toContain(
      "requestElicitation:(t.toolConfig.enableRequestElicitation||this.supportsElicitation())?",
    );
  });

  it("fails closed when the stable bundle contract drifts", () => {
    const source = `class App{${STABLE_RESOLVER.replace("||!e||t.provider", "||t.providerPresent")}${STABLE_ELICITATION}}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "expected 1 stable config resolver guard, found 0",
    );
  });

  const installedApp = findInstalledStableCopilotApp();

  it("resolves the installed 1.0.80 platform package", () => {
    expect(
      installedApp,
      "No installed @github/copilot platform package at version 1.0.80. Run `npm install` before the server test lane.",
    ).toBeTruthy();
  });

  it("patches the installed 1.0.80 bundle and emits syntactically valid ESM", () => {
    const source = readFileSync(installedApp!.appPath, "utf-8");
    const patched = patchCopilotAppSource(source);

    expect(patched).not.toBe(source);
    expect(patched).toContain("__bridgeGithubMcpOptions");

    const dir = makeTestDir("bridge-copilot-loader-syntax-");
    const modulePath = join(dir, "patched-app.mjs");
    writeFileSync(modulePath, patched);
    expect(() => execFileSync(process.execPath, ["--check", modulePath], { stdio: "pipe" })).not.toThrow();
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

  it("exposes a permissions.pendingRequests method whose result carries only items", () => {
    const rpcTypes = readFileSync(rpcTypesPath!, "utf-8");
    const listType = rpcTypes.match(/export interface PendingPermissionRequestList \{(.*?)\n\}/s)?.[1];
    expect(listType, "PendingPermissionRequestList is no longer declared").toBeTruthy();
    const fields = [...listType!.matchAll(/^\s{4}(\w+)\??:/gm)].map((match) => match[1]);
    expect(fields).toEqual(["items"]);
  });

  it("declares no wire method that enumerates pending user input or elicitation requests", () => {
    const rpcTypes = readFileSync(rpcTypesPath!, "utf-8");
    expect(rpcTypes).not.toMatch(/pendingUserInputs|pendingElicitations/);
  });

  it("forwards GitHub MCP and ask-user options supported by the pinned CLI", () => {
    const clientPath = findInstalledSdkClient();
    expect(clientPath, "No installed @github/copilot-sdk dist/client.js found.").toBeTruthy();
    const client = readFileSync(clientPath!, "utf-8");

    expect(client.match(/githubMcpToolOptions: config\.githubMcpToolOptions,/g)?.length).toBe(2);
    expect(client.match(/askUserVariant: config\.askUserVariant,/g)?.length).toBe(2);
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
    if (packageJson.version === "1.0.80") return { appPath, packageDir };
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
