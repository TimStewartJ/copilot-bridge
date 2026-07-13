import { describe, expect, it } from "vitest";
import { patchCopilotAppSource } from "../copilot-cli-loader.js";

const CONFIG_CALL_SITES = `
async createSession(r){let o=await this.resolveSessionAuth(r);let s={};if(r.enableConfigDiscovery&&o&&!r.provider&&!r.gitHubToken){let p=await this.createBuiltInGitHubMcpConfig(o);p&&(s.mcpServers={"github-mcp-server":p,...s.mcpServers})}}
async resumeSession(l,r){let o=await this.resolveSessionAuth(r);let p={};if(r.enableConfigDiscovery&&o&&!r.provider&&!r.gitHubToken){let g=await this.createBuiltInGitHubMcpConfig(o);g&&(p.mcpServers={"github-mcp-server":g,...p.mcpServers})}}
`;

const CONFIG_CALL_SITES_RENAMED_OPTIONS = `
async createSession(n){let o=await this.resolveSessionAuth(n);let a={};if(n.enableConfigDiscovery&&o&&!n.provider&&!n.gitHubToken){let m=await this.createBuiltInGitHubMcpConfig(o);m&&(a.mcpServers={"github-mcp-server":m,...a.mcpServers})}}
async resumeSession(l,n){let o=await this.resolveSessionAuth(n);let p={};if(n.enableConfigDiscovery&&o&&!n.provider&&!n.gitHubToken){let h=await this.createBuiltInGitHubMcpConfig(o);h&&(p.mcpServers={"github-mcp-server":h,...p.mcpServers})}}
`;

const CONFIG_CALL_SITES_DIFFERENT_SESSION_VARS = `
async createSession(r){let s=await this.resolveSessionAuth(r);let c={};if(r.enableConfigDiscovery&&s&&!r.provider&&!r.gitHubToken){let g=await this.createBuiltInGitHubMcpConfig(s);g&&(c.mcpServers={"github-mcp-server":g,...c.mcpServers})}}
async resumeSession(l,r){let o=await this.resolveSessionAuth(r);let p={};if(r.enableConfigDiscovery&&o&&!r.provider&&!r.gitHubToken){let y=await this.createBuiltInGitHubMcpConfig(o);y&&(p.mcpServers={"github-mcp-server":y,...p.mcpServers})}}
`;

const CONFIG_CALL_SITES_DOLLAR_VARS = `
async createSession($n){let $o=await this.resolveSessionAuth($n);let $a={};if($n.enableConfigDiscovery&&$o&&!$n.provider&&!$n.gitHubToken){let $m=await this.createBuiltInGitHubMcpConfig($o);$m&&($a.mcpServers={"github-mcp-server":$m,...$a.mcpServers})}}
async resumeSession(l,$n){let $o=await this.resolveSessionAuth($n);let $p={};if($n.enableConfigDiscovery&&$o&&!$n.provider&&!$n.gitHubToken){let $h=await this.createBuiltInGitHubMcpConfig($o);$h&&($p.mcpServers={"github-mcp-server":$h,...$p.mcpServers})}}
`;
const CONFIG_CALL_SITES_1_0_70 = `
async createSession(e){let s=await this.resolveSessionAuth(e),c={};if(this.shouldInjectBuiltInGitHubMcp(e)&&s&&!e.provider){let S=await this.createBuiltInGitHubMcpConfig(s);S&&(c.mcpServers={"github-mcp-server":S,...c.mcpServers})}}
async resumeSession(l,e){let o=await this.resolveSessionAuth(e),g={};if(this.shouldInjectBuiltInGitHubMcp(e)&&o&&!e.provider){let S=await this.createBuiltInGitHubMcpConfig(o);S&&(g.mcpServers={"github-mcp-server":S,...g.mcpServers})}}
`;
const ASK_USER_TOOL_SELECTION = `
async function tools(f){let G=!!f.requestUserInput,W=!!f.featureFlags?.ASK_USER_ELICITATION&&!!f.requestElicitation;return W?"ask_user_2":G?"ask_user":"none"}
`;
const ELICITATION_CALLBACK_SELECTION = `
function callbacks(){return{requestElicitation:this.hasEventListeners("elicitation.requested")?q=>this.pendingRequests.requestElicitation(q):void 0}}
`;
const NATIVE_ASK_USER_SOURCE = `${ASK_USER_TOOL_SELECTION}${ELICITATION_CALLBACK_SELECTION}`;

describe("copilot-cli-loader", () => {
  it("patches the current simple GitHub MCP config method shape", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(r)return _0t(r,e,{},N)}${CONFIG_CALL_SITES}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("async createBuiltInGitHubMcpConfig(e,__bridgeGithubMcpOptions={})");
    expect(patched).toContain("return _0t(r,e,{...__bridgeGithubMcpOptions},N)");
    expect(patched).toContain("if((r.enableConfigDiscovery||r.githubMcpToolOptions)&&o&&!r.provider&&!r.gitHubToken)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(o,r.githubMcpToolOptions)");
    expect(patched).toContain("let G=!!f.requestUserInput,W=!!f.requestElicitation");
    expect(patched).toContain(
      'requestElicitation:(this.hasEventListeners("elicitation.requested")||this.supportsElicitation())?',
    );
  });

  it("keeps the replaceable-tool exclusion from the older GitHub MCP config method shape", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(!r)return;let n=await Qze();return _0t(r,e,{excludeGhReplaceableTools:n},N)}${CONFIG_CALL_SITES}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("async createBuiltInGitHubMcpConfig(e,__bridgeGithubMcpOptions={})");
    expect(patched).toContain("return _0t(r,e,{excludeGhReplaceableTools:n,...__bridgeGithubMcpOptions},N)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(o,r.githubMcpToolOptions)");
  });

  it("patches call sites when the minified options variable is renamed", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(!r)return;let n=await Qze();return _0t(r,e,{excludeGhReplaceableTools:n},N)}${CONFIG_CALL_SITES_RENAMED_OPTIONS}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("if((n.enableConfigDiscovery||n.githubMcpToolOptions)&&o&&!n.provider&&!n.gitHubToken)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(o,n.githubMcpToolOptions)");
    expect(patched).toContain(`{"github-mcp-server":m,...a.mcpServers}`);
    expect(patched).toContain(`{"github-mcp-server":h,...p.mcpServers}`);
    expect(patched).not.toContain("r.githubMcpToolOptions");
  });

  it("patches call sites that use different minified session variables", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(!r)return;let n=await Qze();return _0t(r,e,{excludeGhReplaceableTools:n},N)}${CONFIG_CALL_SITES_DIFFERENT_SESSION_VARS}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("if((r.enableConfigDiscovery||r.githubMcpToolOptions)&&s&&!r.provider&&!r.gitHubToken)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(s,r.githubMcpToolOptions)");
    expect(patched).toContain(`{"github-mcp-server":g,...c.mcpServers}`);
    expect(patched).toContain("if((r.enableConfigDiscovery||r.githubMcpToolOptions)&&o&&!r.provider&&!r.gitHubToken)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(o,r.githubMcpToolOptions)");
    expect(patched).toContain(`{"github-mcp-server":y,...p.mcpServers}`);
  });

  it("patches the 1.0.68 method shape whose resolver is minified with a $ identifier", () => {
    // Real @github/copilot 1.0.68 minified shape: replaceable-tools resolver is "$R".
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let n;try{n=await pi(e)}catch{return}if(!n)return;let r=await $R();return SSe(n,e,{excludeGhReplaceableTools:r},x)}${CONFIG_CALL_SITES}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("async createBuiltInGitHubMcpConfig(e,__bridgeGithubMcpOptions={})");
    expect(patched).toContain("let r=await $R()");
    expect(patched).toContain("return SSe(n,e,{excludeGhReplaceableTools:r,...__bridgeGithubMcpOptions},x)");
    expect(patched).toContain("if((r.enableConfigDiscovery||r.githubMcpToolOptions)&&o&&!r.provider&&!r.gitHubToken)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig(o,r.githubMcpToolOptions)");
  });

  it("patches call sites whose minified variables contain $ identifiers", () => {
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let r;try{r=await Fa(e)}catch{return}if(!r)return;let n=await Qze();return _0t(r,e,{excludeGhReplaceableTools:n},N)}${CONFIG_CALL_SITES_DOLLAR_VARS}${NATIVE_ASK_USER_SOURCE}}`;

    const patched = patchCopilotAppSource(source);

    expect(patched).toContain("if(($n.enableConfigDiscovery||$n.githubMcpToolOptions)&&$o&&!$n.provider&&!$n.gitHubToken)");
    expect(patched).toContain("this.createBuiltInGitHubMcpConfig($o,$n.githubMcpToolOptions)");
    expect(patched).toContain(`{"github-mcp-server":$m,...$a.mcpServers}`);
    expect(patched).toContain(`{"github-mcp-server":$h,...$p.mcpServers}`);
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

  it("rejects a single helper-based config call site", () => {
    const oneCallSite = CONFIG_CALL_SITES_1_0_70.trim().split(/\r?\n/)[0];
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let n;try{n=await lo(e)}catch{return}if(!n)return;let r=await vR();return SSe(n,e,{excludeGhReplaceableTools:r},T)}${oneCallSite}${NATIVE_ASK_USER_SOURCE}}`;

    expect(() => patchCopilotAppSource(source)).toThrow("found 0 legacy and 1 helper");
  });

  it("rejects mixed legacy and helper-based config call sites", () => {
    const legacyCallSite = CONFIG_CALL_SITES.trim().split(/\r?\n/)[0];
    const helperCallSite = CONFIG_CALL_SITES_1_0_70.trim().split(/\r?\n/)[0];
    const source = `class App{async createBuiltInGitHubMcpConfig(e){let n;try{n=await lo(e)}catch{return}if(!n)return;let r=await vR();return SSe(n,e,{excludeGhReplaceableTools:r},T)}${legacyCallSite}${helperCallSite}${NATIVE_ASK_USER_SOURCE}}`;

    expect(() => patchCopilotAppSource(source)).toThrow("found 1 legacy and 1 helper");
  });
});
