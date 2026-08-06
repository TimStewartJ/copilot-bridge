import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { patchCopilotAppSource } from "../copilot-cli-loader.js";

// Retained only as a rejection fixture: the legacy (<= 1.0.70) call-site shape is
// no longer patched, so a bundle that reverts to it must fail loudly instead of
// launching unpatched.
const LEGACY_CONFIG_CALL_SITES = `
async createSession(r){let o=await this.resolveSessionAuth(r);let s={};if(r.enableConfigDiscovery&&o&&!r.provider&&!r.gitHubToken){let p=await this.createBuiltInGitHubMcpConfig(o);p&&(s.mcpServers={"github-mcp-server":p,...s.mcpServers})}}
async resumeSession(l,r){let o=await this.resolveSessionAuth(r);let p={};if(r.enableConfigDiscovery&&o&&!r.provider&&!r.gitHubToken){let g=await this.createBuiltInGitHubMcpConfig(o);g&&(p.mcpServers={"github-mcp-server":g,...p.mcpServers})}}
`;

const CONFIG_CALL_SITES_1_0_70 = `
async createSession(e){let s=await this.resolveSessionAuth(e),c={};if(this.shouldInjectBuiltInGitHubMcp(e)&&s&&!e.provider){let S=await this.createBuiltInGitHubMcpConfig(s);S&&(c.mcpServers={"github-mcp-server":S,...c.mcpServers})}}
async resumeSession(l,e){let o=await this.resolveSessionAuth(e),g={};if(this.shouldInjectBuiltInGitHubMcp(e)&&o&&!e.provider){let S=await this.createBuiltInGitHubMcpConfig(o);S&&(g.mcpServers={"github-mcp-server":S,...g.mcpServers})}}
`;
// Same helper shape, but every identifier renamed — including "$"-prefixed ones
// the Copilot minifier emits — so the patch survives a minifier reshuffle.
const CONFIG_CALL_SITES_RENAMED_DOLLAR_VARS = `
async createSession($n){let $o=await this.resolveSessionAuth($n),$a={};if(this.shouldInjectBuiltInGitHubMcp($n)&&$o&&!$n.provider){let $m=await this.createBuiltInGitHubMcpConfig($o);$m&&($a.mcpServers={"github-mcp-server":$m,...$a.mcpServers})}}
async resumeSession(l,$n){let $p=await this.resolveSessionAuth($n),$q={};if(this.shouldInjectBuiltInGitHubMcp($n)&&$p&&!$n.provider){let $h=await this.createBuiltInGitHubMcpConfig($p);$h&&($q.mcpServers={"github-mcp-server":$h,...$q.mcpServers})}}
`;
const GITHUB_MCP_CONFIG_METHOD_1_0_71 = `
async createBuiltInGitHubMcpConfig(e,n,r,o){let s;try{s=await ji(e)}catch{return}if(!s)return;let a=await HR(),l=await pn.load(o??this.options.settings),c=await this.coreServices.createFeatureFlagService({sessionId:n}).isFidesIfcEnabled().catch(()=>this.options.featureFlags?.FIDES_IFC??!1),u=KF({settings:VF(l),session:r},c);return rwe(s,e,{...u,excludeGhReplaceableTools:a},x)}
`;
const CONFIG_CALL_SITES_1_0_71 = `
async createSession(e){let a=await this.resolveSessionAuth(e),l=this.sessionId,s={};if(this.shouldInjectBuiltInGitHubMcp(e)&&a&&!e.provider){let E=await this.createBuiltInGitHubMcpConfig(a,l,s,e.configDir?{configDir:e.configDir}:void 0);E&&(u.mcpServers={"github-mcp-server":E,...u.mcpServers})}}
async resumeSession(l,e){let o=await this.resolveSessionAuth(e),g={};if(this.shouldInjectBuiltInGitHubMcp(e)&&o&&!e.provider){let w=await this.createBuiltInGitHubMcpConfig(o,e.sessionId,void 0,e.configDir?{configDir:e.configDir}:void 0);w&&(g.mcpServers={"github-mcp-server":w,...g.mcpServers})}}
`;
const ASK_USER_TOOL_SELECTION = `
async function tools(f){let G=!!f.requestUserInput,W=!!f.featureFlags?.ASK_USER_ELICITATION&&!!f.requestElicitation;return W?"ask_user_2":G?"ask_user":"none"}
`;
const ELICITATION_CALLBACK_SELECTION = `
function callbacks(B){return{requestElicitation:B.toolConfig.enableRequestElicitation?q=>this.pendingRequests.requestElicitation(q):void 0}}
`;
const SUPPORTS_ELICITATION = `
class Caps{supportsElicitation(){return m.sessionCapabilitiesEffectiveHas(this.nativeSessionId,"elicitation")}}
`;
const NATIVE_ASK_USER_SOURCE =
  `${ASK_USER_TOOL_SELECTION}${ELICITATION_CALLBACK_SELECTION}${SUPPORTS_ELICITATION}`;

describe("copilot-cli-loader installed-package contract", () => {
  // The Copilot bundle patches are regex-driven, so a dependency bump can break
  // them. `@github/copilot` is exact-pinned, which makes drift a controlled CI
  // event — but only if CI actually runs the patches against the installed
  // bundle instead of synthetic fixtures. This test is that gate: it fails on
  // upgrade here rather than at app-mode launch.
  const installedAppSources = findInstalledCopilotAppSources();

  it("resolves at least one installed @github/copilot app bundle", () => {
    expect(
      installedAppSources.length,
      "No installed @github/copilot app.js found. Run `npm ci` before the server test lane.",
    ).toBeGreaterThan(0);
  });

  it.each(installedAppSources)("patches the installed bundle at %s", (appPath) => {
    const source = readFileSync(appPath, "utf-8");

    const patched = patchCopilotAppSource(source);

    expect(patched).not.toBe(source);
    expect(patched).toContain("__bridgeGithubMcpOptions");
    expect(patched).toContain("||this.supportsElicitation())?");
    expect(patched).toContain(".toolConfig.enableRequestElicitation||this.supportsElicitation()");
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
});

describe("copilot-cli-loader", () => {
  it("patches the current simple GitHub MCP config method shape", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(r)return _0t(r,e,{},N)}${CONFIG_CALL_SITES_1_0_70}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("async createBuiltInGitHubMcpConfig(e,__bridgeGithubMcpOptions={})");
    // An empty config object literal cannot be spread into positionally, so the
    // patch must emit `{...opts}` rather than a leading-comma `{,...opts}`.
    expect(patched).toContain("return _0t(r,e,{...__bridgeGithubMcpOptions},N)");
    expect(patched).toContain("if((this.shouldInjectBuiltInGitHubMcp(e)||(e.githubMcpToolOptions&&!e.gitHubToken))&&s&&!e.provider)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(s,e.githubMcpToolOptions)");
    expect(patched).toContain("let G=!!f.requestUserInput,W=!!f.requestElicitation");
    expect(patched).toContain(
      "requestElicitation:(B.toolConfig.enableRequestElicitation||this.supportsElicitation())?",
    );
  });

  it("keeps the replaceable-tool exclusion from the older GitHub MCP config method shape", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(!r)return;let n=await Qze();return _0t(r,e,{excludeGhReplaceableTools:n},N)}${CONFIG_CALL_SITES_1_0_70}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("async createBuiltInGitHubMcpConfig(e,__bridgeGithubMcpOptions={})");
    expect(patched).toContain("return _0t(r,e,{excludeGhReplaceableTools:n,...__bridgeGithubMcpOptions},N)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(s,e.githubMcpToolOptions)");
  });

  it("patches call sites that use different minified session and target variables", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(!r)return;let n=await Qze();return _0t(r,e,{excludeGhReplaceableTools:n},N)}${CONFIG_CALL_SITES_1_0_70}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("if((this.shouldInjectBuiltInGitHubMcp(e)||(e.githubMcpToolOptions&&!e.gitHubToken))&&s&&!e.provider)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(s,e.githubMcpToolOptions)");
    expect(patched).toContain(`{"github-mcp-server":S,...c.mcpServers}`);
    expect(patched).toContain("if((this.shouldInjectBuiltInGitHubMcp(e)||(e.githubMcpToolOptions&&!e.gitHubToken))&&o&&!e.provider)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(o,e.githubMcpToolOptions)");
    expect(patched).toContain(`{"github-mcp-server":S,...g.mcpServers}`);
  });

  it("patches the 1.0.68 method shape whose resolver is minified with a $ identifier", () => {
    // Real @github/copilot 1.0.68 minified shape: replaceable-tools resolver is "$R".
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let n;try{n=await pi(e)}catch{return}if(!n)return;let r=await $R();return SSe(n,e,{excludeGhReplaceableTools:r},x)}${CONFIG_CALL_SITES_1_0_70}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("async createBuiltInGitHubMcpConfig(e,__bridgeGithubMcpOptions={})");
    expect(patched).toContain("let r=await $R()");
    expect(patched).toContain("return SSe(n,e,{excludeGhReplaceableTools:r,...__bridgeGithubMcpOptions},x)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(s,e.githubMcpToolOptions)");
  });

  it("patches call sites whose minified variables are renamed and contain $ identifiers", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(!r)return;let n=await Qze();return _0t(r,e,{excludeGhReplaceableTools:n},N)}${CONFIG_CALL_SITES_RENAMED_DOLLAR_VARS}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("if((this.shouldInjectBuiltInGitHubMcp($n)||($n.githubMcpToolOptions&&!$n.gitHubToken))&&$o&&!$n.provider)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig($o,$n.githubMcpToolOptions)");
    expect(patched).toContain(`{"github-mcp-server":$m,...$a.mcpServers}`);
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig($p,$n.githubMcpToolOptions)");
    expect(patched).toContain(`{"github-mcp-server":$h,...$q.mcpServers}`);
  });

  it("patches the 1.0.70 helper-based GitHub MCP config call sites", () => {
    const source = `class App{shouldInjectBuiltInGitHubMcp(e){let n=process.env[x]==="true";return e.enableConfigDiscovery===!0&&(!e.gitHubToken||n)}async createBuiltInGitHubMcpConfig(e){let n;try{n=await lo(e)}catch{return}if(!n)return;let r=await vR();return SSe(n,e,{excludeGhReplaceableTools:r},T)}${CONFIG_CALL_SITES_1_0_70}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("if((this.shouldInjectBuiltInGitHubMcp(e)||(e.githubMcpToolOptions&&!e.gitHubToken))&&s&&!e.provider)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(s,e.githubMcpToolOptions)");
    expect(patched).toContain("if((this.shouldInjectBuiltInGitHubMcp(e)||(e.githubMcpToolOptions&&!e.gitHubToken))&&o&&!e.provider)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(o,e.githubMcpToolOptions)");
    expect(patched).toContain("let G=!!f.requestUserInput,W=!!f.requestElicitation");
  });

  it("patches the 1.0.71 Fides-aware GitHub MCP config shape", () => {
    const source = `class App{${GITHUB_MCP_CONFIG_METHOD_1_0_71}${CONFIG_CALL_SITES_1_0_71}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("async createBuiltInGitHubMcpConfig(e,n,r,o,__bridgeGithubMcpOptions={})");
    expect(patched).toContain(
      "return rwe(s,e,{...u,excludeGhReplaceableTools:a,...__bridgeGithubMcpOptions},x)",
    );
    expect(patched).toContain(
      "this.createBuiltInGitHubMcpConfig(a,l,s,e.configDir?{configDir:e.configDir}:void 0,e.githubMcpToolOptions)",
    );
    expect(patched).toContain(
      "this.createBuiltInGitHubMcpConfig(o,e.sessionId,void 0,e.configDir?{configDir:e.configDir}:void 0,e.githubMcpToolOptions)",
    );
    expect(patched).toContain("let G=!!f.requestUserInput,W=!!f.requestElicitation");
  });

  it("rejects config call sites that are missing, partial, or reverted to the legacy shape", () => {
    const method =
      `async createBuiltInGitHubMcpConfig(e){let n;try{n=await lo(e)}catch{return}if(!n)return;let r=await vR();return SSe(n,e,{excludeGhReplaceableTools:r},T)}`;

    // rejects a single helper-based config call site
    {
      const oneCallSite = CONFIG_CALL_SITES_1_0_70.trim().split(/\r?\n/)[0];
      const source = `class App{${method}${oneCallSite}${NATIVE_ASK_USER_SOURCE}}`;

      expect(() => patchCopilotAppSource(source)).toThrow(
        "expected exactly 2 helper config call sites, found 1",
      );
    }

    // A bundle that reverts to the pre-1.0.71 call-site shape is no longer
    // patched, so it must fail loudly rather than launch unpatched.
    {
      const source = `class App{${method}${LEGACY_CONFIG_CALL_SITES}${NATIVE_ASK_USER_SOURCE}}`;

      expect(() => patchCopilotAppSource(source)).toThrow(
        "expected exactly 2 helper config call sites, found 0",
      );
    }
  });

  it("rejects SDK drift that removes the runtime elicitation capability probe", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(r)return _0t(r,e,{},N)}${CONFIG_CALL_SITES_1_0_70}${ASK_USER_TOOL_SELECTION}${ELICITATION_CALLBACK_SELECTION}}`;

    expect(() => patchCopilotAppSource(source)).toThrow(
      "expected 1 supportsElicitation definition, found 0",
    );
  });
});

/**
 * Locate every installed Copilot application bundle. Platform-specific packages
 * (`@github/copilot-<variant>-<arch>`) and the monolithic `@github/copilot`
 * layout are both supported, mirroring `copilot-cli-wrapper.js`.
 */
function findInstalledCopilotAppSources(): string[] {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return [];
  return readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("copilot"))
    .map((entry) => join(scopeDir, entry.name, "app.js"))
    .filter((appPath) => existsSync(appPath))
    .sort();
}

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

/** Locate the installed SDK's generated RPC type declarations, if present. */
function findInstalledSdkGeneratedRpcTypes(): string | undefined {
  const scopeDir = findGithubScopeDir();
  if (!scopeDir) return undefined;
  const candidate = join(scopeDir, "copilot-sdk", "dist", "generated", "rpc.d.ts");
  return existsSync(candidate) ? candidate : undefined;
}
