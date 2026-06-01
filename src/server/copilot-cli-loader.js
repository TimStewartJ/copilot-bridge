const GITHUB_MCP_CONFIG_METHOD_PATTERN = /async createBuiltInGitHubMcpConfig\((\w+)\)\{let (\w+);try\{\2=await (\w+)\(\1\)\}catch\{return\}if\(!\2\)return;let (\w+)=await (\w+)\(\);return (\w+)\(\2,\1,\{excludeGhReplaceableTools:\4\},(\w+)\)\}/g;
const GITHUB_MCP_CONFIG_SIMPLE_METHOD_PATTERN = /async createBuiltInGitHubMcpConfig\((\w+)\)\{let (\w+);try\{\2=await (\w+)\(\1\)\}catch\{return\}if\(\2\)return (\w+)\(\2,\1,\{\},(\w+)\)\}/g;
const GITHUB_MCP_CONFIG_CALL_PATTERN = /if\(r\.enableConfigDiscovery&&o&&!r\.provider&&!r\.gitHubToken\)\{let (\w+)=await this\.createBuiltInGitHubMcpConfig\(o\);\1&&\((\w+)\.mcpServers=\{"github-mcp-server":\1,\.\.\.(\w+)\.mcpServers\}\)\}/g;

export function patchCopilotAppSource(source) {
  let methodMatches = 0;
  source = source.replace(
    GITHUB_MCP_CONFIG_METHOD_PATTERN,
    (match, authParam, tokenVar, tokenResolver, replaceableToolsVar, replaceableToolsResolver, configBuilder, logger) => {
      methodMatches++;
      return `async createBuiltInGitHubMcpConfig(${authParam},__bridgeGithubMcpOptions={}){let ${tokenVar};try{${tokenVar}=await ${tokenResolver}(${authParam})}catch{return}if(!${tokenVar})return;let ${replaceableToolsVar}=await ${replaceableToolsResolver}();return ${configBuilder}(${tokenVar},${authParam},{excludeGhReplaceableTools:${replaceableToolsVar},...__bridgeGithubMcpOptions},${logger})}`;
    },
  );
  source = source.replace(
    GITHUB_MCP_CONFIG_SIMPLE_METHOD_PATTERN,
    (match, authParam, tokenVar, tokenResolver, configBuilder, logger) => {
      methodMatches++;
      return `async createBuiltInGitHubMcpConfig(${authParam},__bridgeGithubMcpOptions={}){let ${tokenVar};try{${tokenVar}=await ${tokenResolver}(${authParam})}catch{return}if(!${tokenVar})return;return ${configBuilder}(${tokenVar},${authParam},{...__bridgeGithubMcpOptions},${logger})}`;
    },
  );
  if (methodMatches !== 1) {
    throw new Error(`Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 config method, found ${methodMatches}.`);
  }

  let callMatches = 0;
  source = source.replace(
    GITHUB_MCP_CONFIG_CALL_PATTERN,
    (match, configVar, sessionVar) => {
      callMatches++;
      return `if((r.enableConfigDiscovery||r.githubMcpToolOptions)&&o&&!r.provider&&!r.gitHubToken){let ${configVar}=await this.createBuiltInGitHubMcpConfig(o,r.githubMcpToolOptions);${configVar}&&(${sessionVar}.mcpServers={"github-mcp-server":${configVar},...${sessionVar}.mcpServers})}`;
    },
  );
  if (callMatches !== 2) {
    throw new Error(`Unable to patch Copilot app for Bridge GitHub MCP auth: expected 2 config call sites, found ${callMatches}.`);
  }

  return source;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== process.env.BRIDGE_COPILOT_APP_URL) return result;
  if (result.source === undefined || result.source === null) {
    throw new Error("Unable to patch Copilot app for Bridge GitHub MCP auth: loader returned no source.");
  }
  const source = typeof result.source === "string"
    ? result.source
    : Buffer.from(result.source).toString("utf8");
  return {
    ...result,
    source: patchCopilotAppSource(source),
  };
}
