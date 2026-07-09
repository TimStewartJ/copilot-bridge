// Minified JS identifiers can legally contain "$" (and "_"), which the Copilot
// bundle's minifier uses for some helper names (e.g. "$R"). Match the full set
// of valid identifier characters so pattern matching survives minifier renames.
const ID = String.raw`[$A-Za-z_][\w$]*`;

const GITHUB_MCP_CONFIG_METHOD_PATTERN = new RegExp(
  String.raw`async createBuiltInGitHubMcpConfig\((${ID})\)\{let (${ID});try\{\2=await (${ID})\(\1\)\}catch\{return\}if\(!\2\)return;let (${ID})=await (${ID})\(\);return (${ID})\(\2,\1,\{excludeGhReplaceableTools:\4\},(${ID})\)\}`,
  "g",
);
const GITHUB_MCP_CONFIG_SIMPLE_METHOD_PATTERN = new RegExp(
  String.raw`async createBuiltInGitHubMcpConfig\((${ID})\)\{let (${ID});try\{\2=await (${ID})\(\1\)\}catch\{return\}if\(\2\)return (${ID})\(\2,\1,\{\},(${ID})\)\}`,
  "g",
);
const GITHUB_MCP_CONFIG_CALL_PATTERN = new RegExp(
  String.raw`if\((${ID})\.enableConfigDiscovery&&(${ID})&&!\1\.provider&&!\1\.gitHubToken\)\{let (${ID})=await this\.createBuiltInGitHubMcpConfig\(\2\);\3&&\((${ID})\.mcpServers=\{"github-mcp-server":\3,\.\.\.\4\.mcpServers\}\)\}`,
  "g",
);

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
    (match, optionsVar, sessionVar, configVar, mcpTargetVar) => {
      callMatches++;
      return `if((${optionsVar}.enableConfigDiscovery||${optionsVar}.githubMcpToolOptions)&&${sessionVar}&&!${optionsVar}.provider&&!${optionsVar}.gitHubToken){let ${configVar}=await this.createBuiltInGitHubMcpConfig(${sessionVar},${optionsVar}.githubMcpToolOptions);${configVar}&&(${mcpTargetVar}.mcpServers={"github-mcp-server":${configVar},...${mcpTargetVar}.mcpServers})}`;
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
