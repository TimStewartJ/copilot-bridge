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
const GITHUB_MCP_CONFIG_HELPER_CALL_PATTERN = new RegExp(
  String.raw`if\(this\.shouldInjectBuiltInGitHubMcp\((${ID})\)&&(${ID})&&!\1\.provider\)\{let (${ID})=await this\.createBuiltInGitHubMcpConfig\(\2\);\3&&\((${ID})\.mcpServers=\{"github-mcp-server":\3,\.\.\.\4\.mcpServers\}\)\}`,
  "g",
);
// The CLI already ships the native schema-driven ask_user implementation, but
// currently keeps it behind a runtime flag and fails to construct its callback
// for headless SDK capability providers. These drift-checked patches remove
// only those two gates; the native descriptor, validation, and result handling
// remain owned by Copilot.
const ASK_USER_ELICITATION_PATTERN = new RegExp(
  String.raw`let (${ID})=!!(${ID})\.requestUserInput,(${ID})=!!\2\.featureFlags\?\.ASK_USER_ELICITATION&&!!\2\.requestElicitation;`,
  "g",
);
const ELICITATION_CALLBACK_PATTERN = /requestElicitation:this\.hasEventListeners\("elicitation\.requested"\)\?/g;

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

  let legacyCallMatches = 0;
  source = source.replace(
    GITHUB_MCP_CONFIG_CALL_PATTERN,
    (match, optionsVar, sessionVar, configVar, mcpTargetVar) => {
      legacyCallMatches++;
      return `if((${optionsVar}.enableConfigDiscovery||${optionsVar}.githubMcpToolOptions)&&${sessionVar}&&!${optionsVar}.provider&&!${optionsVar}.gitHubToken){let ${configVar}=await this.createBuiltInGitHubMcpConfig(${sessionVar},${optionsVar}.githubMcpToolOptions);${configVar}&&(${mcpTargetVar}.mcpServers={"github-mcp-server":${configVar},...${mcpTargetVar}.mcpServers})}`;
    },
  );
  let helperCallMatches = 0;
  source = source.replace(
    GITHUB_MCP_CONFIG_HELPER_CALL_PATTERN,
    (match, optionsVar, sessionVar, configVar, mcpTargetVar) => {
      helperCallMatches++;
      return `if((this.shouldInjectBuiltInGitHubMcp(${optionsVar})||(${optionsVar}.githubMcpToolOptions&&!${optionsVar}.gitHubToken))&&${sessionVar}&&!${optionsVar}.provider){let ${configVar}=await this.createBuiltInGitHubMcpConfig(${sessionVar},${optionsVar}.githubMcpToolOptions);${configVar}&&(${mcpTargetVar}.mcpServers={"github-mcp-server":${configVar},...${mcpTargetVar}.mcpServers})}`;
    },
  );
  const hasLegacyCallSites = legacyCallMatches === 2 && helperCallMatches === 0;
  const hasHelperCallSites = legacyCallMatches === 0 && helperCallMatches === 2;
  if (!hasLegacyCallSites && !hasHelperCallSites) {
    throw new Error(
      "Unable to patch Copilot app for Bridge GitHub MCP auth: expected exactly 2 legacy or 2 helper config call sites, "
        + `found ${legacyCallMatches} legacy and ${helperCallMatches} helper.`,
    );
  }

  let askUserMatches = 0;
  source = source.replace(
    ASK_USER_ELICITATION_PATTERN,
    (match, legacyVar, optionsVar, elicitationVar) => {
      askUserMatches++;
      return `let ${legacyVar}=!!${optionsVar}.requestUserInput,${elicitationVar}=!!${optionsVar}.requestElicitation;`;
    },
  );
  if (askUserMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for native ask_user elicitation: expected 1 tool-selection gate, found ${askUserMatches}.`,
    );
  }

  let elicitationCallbackMatches = 0;
  source = source.replace(
    ELICITATION_CALLBACK_PATTERN,
    () => {
      elicitationCallbackMatches++;
      return 'requestElicitation:(this.hasEventListeners("elicitation.requested")||this.supportsElicitation())?';
    },
  );
  if (elicitationCallbackMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for SDK elicitation callbacks: expected 1 callback gate, found ${elicitationCallbackMatches}.`,
    );
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
