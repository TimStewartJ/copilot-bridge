import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { patchCopilotAppSource } from "../copilot-cli-loader.js";
import { resolveCopilotCliForLaunch } from "../copilot-cli-pin.js";
import { resolveRuntimePaths } from "../runtime-paths.js";
import { makeTestDir } from "./helpers.js";

const SUPPORTS_ELICITATION = `
class Caps{supportsElicitation(){return m.sessionCapabilitiesEffectiveHas(this.nativeSessionId,"elicitation")}}
`;
// Real @github/copilot 1.0.81-6 shape: the resolver receives the normalized
// session params (hasGitHubToken/providerPresent/authContextId), merges tool
// options natively, and builds the config through a native auth-context call.
const GITHUB_MCP_CONFIG_RESOLVER_1_0_81 = `
async resolveBuiltInGitHubMcpConfig(t,n,r,o=!1){if(!this.shouldInjectBuiltInGitHubMcp(t)||t.providerPresent)return;let s=await y.githubMcpShouldExcludeGhReplaceableTools(),a=await y.userSettingsLoad({configDir:(t.configDir?{configDir:t.configDir}:this.options.settings)?.configDir,homeDirectory:X_.homedir(),environment:process.env}),l=this.options.featureFlags?.FIDES_IFC??!1,c=y.githubMcpResolveToolOptionsTyped(void 0,JSON.stringify(y.githubMcpToolOptionsFromSettings(a)),r===void 0?void 0:JSON.stringify(r),l,s),d=await y.githubMcpResolveConfigForAuthContext(this.authManager.managerConfig(),t.authContextId,{...c,copilotIntegrationId:this.integrationId,enableMcpApps:o});if(d)return{config:JSON.parse(d.configJson),userOverrode:c.userOverrode}}
`;
// 1.0.81 hands the host's elicitation capability to the native session plan;
// the JS gates patched for older bundles no longer exist.
const NATIVE_ELICITATION_SOURCE = `
class Host{plan(t){return{askUserVariant:t.askUserVariant,hostSupportsElicitation:t.requestElicitation===!0}}}${SUPPORTS_ELICITATION}
`;

describe("copilot-cli-loader pinned-bundle contract", () => {
  // The Copilot bundle patch is regex-driven, so a CLI pin bump can break it.
  // This gate runs the patch against the real pinned build whenever it is in the
  // cache (any host that has run the server or a staging preview with the
  // current copilot-cli.lock.json), so drift fails validation instead of launch.
  const pinnedAppSource = findPinnedCopilotAppSource();

  it.skipIf(!pinnedAppSource)("patches the pinned bundle", () => {
    const source = readFileSync(pinnedAppSource!, "utf-8");

    const patched = patchCopilotAppSource(source);

    expect(patched).not.toBe(source);
    expect(patched).toContain("__bridgeGithubMcpOptions");
    expect(patched).toContain(".hasGitHubToken))||");
    expect(patched).toContain("enableMcpApps:o,...__bridgeGithubMcpOptions})");
  });

  // Match counts alone cannot prove the rewritten bundle is loadable: a regex
  // that matches the wrong span still produces confident-looking output that
  // only fails when Node parses it at app-mode launch. Parse it here instead.
  it.skipIf(!pinnedAppSource)("emits syntactically valid ESM for the pinned bundle", () => {
    const patched = patchCopilotAppSource(readFileSync(pinnedAppSource!, "utf-8"));

    const dir = makeTestDir("bridge-copilot-loader-syntax-");
    const modulePath = join(dir, "patched-app.mjs");
    writeFileSync(modulePath, patched);

    expect(() =>
      execFileSync(process.execPath, ["--check", modulePath], { stdio: "pipe" }),
    ).not.toThrow();
  });
});

describe("installed @github/copilot-sdk pending-interaction contract", () => {
  // Bridge serves pending `ask_user` / elicitation listings exclusively from its
  // own event-derived index (`SessionEventBus`), because the SDK exposes no wire
  // method that enumerates them: `session.permissions.pendingRequests` answers
  // with permission prompts only. This test pins that fact to the *installed*
  // generated RPC surface so an SDK bump that grows a real listing method fails
  // here — at which point runtime-sourced listing should be reconsidered, rather
  // than Bridge silently staying on the index forever.
  const rpcTypesPath = findInstalledSdkGeneratedRpcTypes();

  it("resolves the installed generated RPC type declarations", () => {
    expect(
      rpcTypesPath,
      "No installed @github/copilot-sdk generated rpc.d.ts found. Run `npm ci` before the server test lane.",
    ).toBeTruthy();
  });

  it("exposes a permissions.pendingRequests method whose result carries only `items`", () => {
    const rpcTypes = readFileSync(rpcTypesPath!, "utf-8");

    const listType = rpcTypes.match(
      /export interface PendingPermissionRequestList \{(.*?)\n\}/s,
    )?.[1];
    expect(listType, "PendingPermissionRequestList is no longer declared").toBeTruthy();

    const fields = [...listType!.matchAll(/^\s{4}(\w+)\??:/gm)].map((match) => match[1]);
    expect(fields).toEqual(["items"]);
  });

  it("declares no wire method that enumerates pending user input or elicitation requests", () => {
    const rpcTypes = readFileSync(rpcTypesPath!, "utf-8");

    expect(rpcTypes).not.toMatch(/pendingUserInputs|pendingElicitations/);
  });

  // The SDK transport patch (patches/@github+copilot-sdk+*.patch) forwards two
  // wire fields the published client does not map yet: Bridge's GitHub MCP tool
  // options and the ask_user variant. Both create and resume must carry them,
  // otherwise web_search or ask_user silently drop out of the toolset on newer
  // runtimes. Pin the installed (patched) client so a dependency bump that
  // loses the patch fails here.
  it("forwards githubMcpToolOptions and askUserVariant on session create and resume", () => {
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


describe("copilot-cli-loader", () => {
  it("patches the 1.0.81 native auth-context GitHub MCP resolver shape", () => {
    const source = `class App{${GITHUB_MCP_CONFIG_RESOLVER_1_0_81}${NATIVE_ELICITATION_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain(
      "async resolveBuiltInGitHubMcpConfig(t,n,r,o=!1){const __bridgeGithubMcpOptions=t.githubMcpToolOptions;",
    );
    // The guard keys off the normalized params: hasGitHubToken replaces the raw
    // token, providerPresent replaces provider, and the auth handle is no longer
    // a parameter.
    expect(patched).toContain(
      "if((!this.shouldInjectBuiltInGitHubMcp(t)&&!(__bridgeGithubMcpOptions&&!t.hasGitHubToken))||t.providerPresent)return;",
    );
    // Bridge options land on the native config call, not on the session tool
    // config layer, so userOverrode stays settings-derived.
    expect(patched).toContain(
      "{...c,copilotIntegrationId:this.integrationId,enableMcpApps:o,...__bridgeGithubMcpOptions})",
    );
    expect(patched).toContain("r===void 0?void 0:JSON.stringify(r)");
    expect(patched).toContain("userOverrode:c.userOverrode");
    // No legacy elicitation gates exist in this shape and none are required.
    expect(patched).not.toContain("enableRequestElicitation");
  });

  it("rejects a 1.0.81 resolver whose native config call drifts", () => {
    const method = GITHUB_MCP_CONFIG_RESOLVER_1_0_81.replace(
      "{...c,copilotIntegrationId:this.integrationId,enableMcpApps:o}",
      "{...c,integrationId:this.integrationId,enableMcpApps:o}",
    );
    const source = `class App{${method}${NATIVE_ELICITATION_SOURCE}}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "expected 1 native config call, found 0",
    );
  });

  it("rejects a 1.0.81 resolver whose return drifts", () => {
    const method = GITHUB_MCP_CONFIG_RESOLVER_1_0_81.replace(
      "userOverrode:c.userOverrode}",
      "override:c.userOverrode}",
    );
    const source = `class App{${method}${NATIVE_ELICITATION_SOURCE}}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "expected 1 native config resolver return, found 0",
    );
  });


  it("rejects a bundle without the native elicitation capability", () => {
    const source = `class App{${GITHUB_MCP_CONFIG_RESOLVER_1_0_81}${SUPPORTS_ELICITATION}}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "does not pass hostSupportsElicitation",
    );
  });

  it("rejects a bundle whose resolver guard drifts", () => {
    const method = GITHUB_MCP_CONFIG_RESOLVER_1_0_81.replace("||t.providerPresent)return;", "||t.provider)return;");
    const source = `class App{${method}${NATIVE_ELICITATION_SOURCE}}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "expected 1 native config resolver guard, found 0",
    );
  });

  it("rejects a bundle with no or several config resolvers", () => {
    expect(() => patchCopilotAppSource(`class App{${NATIVE_ELICITATION_SOURCE}}`)).toThrow(
      "expected 1 config resolver, found 0",
    );
    expect(() => patchCopilotAppSource(
      `class App{${GITHUB_MCP_CONFIG_RESOLVER_1_0_81}${GITHUB_MCP_CONFIG_RESOLVER_1_0_81}${NATIVE_ELICITATION_SOURCE}}`,
    )).toThrow("expected 1 config resolver, found 2");
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

/**
 * Locate the Bridge-pinned Copilot CLI build the lock in this code tree points
 * at, when it is already cached. Uses the same cache resolution as the server
 * (BRIDGE_COPILOT_CLI_CACHE_DIR or <dataDir>/copilot-cli) so a launcher-run
 * validation sees the production cache.
 */
function findPinnedCopilotAppSource(): string | undefined {
  const runtimePaths = resolveRuntimePaths(process.env);
  const cacheDir = runtimePaths.copilotCliCacheDir ?? join(runtimePaths.dataDir, "copilot-cli");
  try {
    const appPath = join(resolveCopilotCliForLaunch({ cacheDir }).appDir, "app.js");
    return existsSync(appPath) ? appPath : undefined;
  } catch {
    return undefined;
  }
}

/** Locate the installed SDK's generated RPC type declarations, if present. */
function findInstalledSdkGeneratedRpcTypes(): string | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  const candidate = join(scopeDir, "copilot-sdk", "dist", "generated", "rpc.d.ts");
  return existsSync(candidate) ? candidate : undefined;
}

/** Locate the installed (patch-package-patched) SDK client, if present. */
function findInstalledSdkClient(): string | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  const candidate = join(scopeDir, "copilot-sdk", "dist", "client.js");
  return existsSync(candidate) ? candidate : undefined;
}
