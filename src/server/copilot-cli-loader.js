// Minified JS identifiers can legally contain "$" (and "_"), which the Copilot
// bundle's minifier uses for some helper names (e.g. "$R"). Match the full set
// of valid identifier characters so pattern matching survives minifier renames.
const ID = String.raw`[$A-Za-z_][\w$]*`;

const GITHUB_MCP_CONFIG_METHOD_SIGNATURE_PATTERN = new RegExp(
  String.raw`async createBuiltInGitHubMcpConfig\((${ID}(?:,${ID})*)\)\{`,
  "g",
);
const GITHUB_MCP_CONFIG_RETURN_PATTERN = new RegExp(
  String.raw`return (${ID})\((${ID}),(${ID}),(\{[^{}]*\}),(${ID})\)`,
  "g",
);
const GITHUB_MCP_CONFIG_CALL_PATTERN = new RegExp(
  String.raw`if\((${ID})\.enableConfigDiscovery&&(${ID})&&!\1\.provider&&!\1\.gitHubToken\)\{let (${ID})=await this\.createBuiltInGitHubMcpConfig\(\2\);\3&&\((${ID})\.mcpServers=\{"github-mcp-server":\3,\.\.\.\4\.mcpServers\}\)\}`,
  "g",
);
const GITHUB_MCP_CONFIG_HELPER_CALL_PATTERN = new RegExp(
  String.raw`if\(this\.shouldInjectBuiltInGitHubMcp\((${ID})\)&&(${ID})&&!\1\.provider\)\{let (${ID})=await this\.createBuiltInGitHubMcpConfig\(\2([^;]*?)\);\3&&\((${ID})\.mcpServers=\{"github-mcp-server":\3,\.\.\.\5\.mcpServers\}\)\}`,
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
const PENDING_INTERACTION_METHODS_PATTERN = /getPendingUserInputRequests\(\)\{return this\.pendingRequests\.getPendingUserInputRequests\(\)\}getPendingElicitationRequests\(\)\{return this\.pendingRequests\.getPendingElicitationRequests\(\)\}/g;
const PENDING_INTERACTION_PERMISSIONS_FACADE_PATTERN = new RegExp(
  String.raw`pendingRequests\(\)\{return\{items:(${ID})\((${ID})\)\}\}`,
  "g",
);

export function patchCopilotPendingInteractionRpcSource(source) {
  const pendingInteractionMethodMatches = source.match(PENDING_INTERACTION_METHODS_PATTERN)?.length ?? 0;
  if (pendingInteractionMethodMatches !== 1) {
    throw new Error(
      "Unable to patch Copilot app for pending interaction snapshots: "
        + `expected 1 runtime getter pair, found ${pendingInteractionMethodMatches}.`,
    );
  }

  let pendingInteractionFacadeMatches = 0;
  source = source.replace(
    PENDING_INTERACTION_PERMISSIONS_FACADE_PATTERN,
    (match, permissionSnapshot, sessionVar) => {
      pendingInteractionFacadeMatches++;
      return `pendingRequests(){return{items:${permissionSnapshot}(${sessionVar}),`
        + `pendingUserInputs:${sessionVar}.getPendingUserInputRequests(),`
        + `pendingElicitations:${sessionVar}.getPendingElicitationRequests()}}`;
    },
  );
  if (pendingInteractionFacadeMatches !== 1) {
    throw new Error(
      "Unable to patch Copilot app for pending interaction snapshots: "
        + `expected 1 permissions snapshot facade, found ${pendingInteractionFacadeMatches}.`,
    );
  }

  return source;
}

function findMatchingBrace(source, openBraceIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openBraceIndex; index < source.length; index++) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function patchCopilotAppSource(source) {
  const methodMatches = [...source.matchAll(GITHUB_MCP_CONFIG_METHOD_SIGNATURE_PATTERN)];
  if (methodMatches.length !== 1) {
    throw new Error(`Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 config method, found ${methodMatches.length}.`);
  }
  const methodMatch = methodMatches[0];
  const methodStart = methodMatch.index;
  const methodOpenBrace = methodStart + methodMatch[0].length - 1;
  const methodEnd = findMatchingBrace(source, methodOpenBrace);
  if (methodEnd < 0) {
    throw new Error("Unable to patch Copilot app for Bridge GitHub MCP auth: config method has no matching closing brace.");
  }
  let returnMatches = 0;
  let methodSource = source.slice(methodStart, methodEnd + 1);
  methodSource = methodSource.replace(
    GITHUB_MCP_CONFIG_METHOD_SIGNATURE_PATTERN,
    `async createBuiltInGitHubMcpConfig(${methodMatch[1]},__bridgeGithubMcpOptions={}){`,
  );
  methodSource = methodSource.replace(
    GITHUB_MCP_CONFIG_RETURN_PATTERN,
    (match, configBuilder, tokenVar, authParam, configObject, logger) => {
      returnMatches++;
      const patchedConfigObject = configObject === "{}"
        ? "{...__bridgeGithubMcpOptions}"
        : `${configObject.slice(0, -1)},...__bridgeGithubMcpOptions}`;
      return `return ${configBuilder}(${tokenVar},${authParam},${patchedConfigObject},${logger})`;
    },
  );
  if (returnMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 config return, found ${returnMatches}.`,
    );
  }
  source = source.slice(0, methodStart) + methodSource + source.slice(methodEnd + 1);

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
    (match, optionsVar, sessionVar, configVar, callArgs, mcpTargetVar) => {
      helperCallMatches++;
      return `if((this.shouldInjectBuiltInGitHubMcp(${optionsVar})||(${optionsVar}.githubMcpToolOptions&&!${optionsVar}.gitHubToken))&&${sessionVar}&&!${optionsVar}.provider){let ${configVar}=await this.createBuiltInGitHubMcpConfig(${sessionVar}${callArgs},${optionsVar}.githubMcpToolOptions);${configVar}&&(${mcpTargetVar}.mcpServers={"github-mcp-server":${configVar},...${mcpTargetVar}.mcpServers})}`;
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

  return patchCopilotPendingInteractionRpcSource(source);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const isAppSource = url === process.env.BRIDGE_COPILOT_APP_URL;
  if (!isAppSource) return result;
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
