// Minified JS identifiers can legally contain "$" (and "_"), which the Copilot
// bundle's minifier uses for some helper names (e.g. "$R"). Match the full set
// of valid identifier characters so pattern matching survives minifier renames.
const ID = String.raw`[$A-Za-z_][\w$]*`;
// Copilot CLI >= 1.0.76 gives the config method a defaulted parameter
// (`o=!1`), so parameters are no longer bare identifiers. Only comma- and
// paren-free defaults are accepted: a default containing either character
// fails the whole signature match, which surfaces as a loud drift error
// instead of a silently mis-captured parameter list.
const PARAM = String.raw`${ID}(?:=[^,()]*)?`;

const GITHUB_MCP_CONFIG_METHOD_SIGNATURE_PATTERN = new RegExp(
  String.raw`async createBuiltInGitHubMcpConfig\((${PARAM}(?:,${PARAM})*)\)\{`,
  "g",
);
// The config object stays the third argument, but the trailing arguments after
// it grew from one (logger) to two (logger + the MCP-apps flag) in 1.0.76.
// Trailing arguments are preserved verbatim, so their meaning stays owned by
// Copilot; the bound keeps the drift check tight.
const GITHUB_MCP_CONFIG_RETURN_PATTERN = new RegExp(
  String.raw`return (${ID})\((${ID}),(${ID}),(\{[^{}]*\})((?:,${ID}){1,2})\)`,
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
// Copilot CLI >= 1.0.74 gates the elicitation callback on the runtime's own
// tool plan instead of on JS event listeners. That flag is false for Bridge,
// which advertises the elicitation capability and then unregisters the
// in-process handler so only its transport answers. Widening the gate with the
// runtime's effective capability set keeps `ask_user` in the toolset without
// overriding a capability the runtime itself revoked.
const ELICITATION_CALLBACK_PATTERN = new RegExp(
  String.raw`requestElicitation:(${ID})\.toolConfig\.enableRequestElicitation\?`,
  "g",
);
const SUPPORTS_ELICITATION_PATTERN = /supportsElicitation\(\)\{/g;

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
    (match, configBuilder, tokenVar, authParam, configObject, trailingArgs) => {
      returnMatches++;
      const patchedConfigObject = configObject === "{}"
        ? "{...__bridgeGithubMcpOptions}"
        : `${configObject.slice(0, -1)},...__bridgeGithubMcpOptions}`;
      return `return ${configBuilder}(${tokenVar},${authParam},${patchedConfigObject}${trailingArgs})`;
    },
  );
  if (returnMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 config return, found ${returnMatches}.`,
    );
  }
  source = source.slice(0, methodStart) + methodSource + source.slice(methodEnd + 1);

  let helperCallMatches = 0;
  source = source.replace(
    GITHUB_MCP_CONFIG_HELPER_CALL_PATTERN,
    (match, optionsVar, sessionVar, configVar, callArgs, mcpTargetVar) => {
      helperCallMatches++;
      return `if((this.shouldInjectBuiltInGitHubMcp(${optionsVar})||(${optionsVar}.githubMcpToolOptions&&!${optionsVar}.gitHubToken))&&${sessionVar}&&!${optionsVar}.provider){let ${configVar}=await this.createBuiltInGitHubMcpConfig(${sessionVar}${callArgs},${optionsVar}.githubMcpToolOptions);${configVar}&&(${mcpTargetVar}.mcpServers={"github-mcp-server":${configVar},...${mcpTargetVar}.mcpServers})}`;
    },
  );
  if (helperCallMatches !== 2) {
    throw new Error(
      "Unable to patch Copilot app for Bridge GitHub MCP auth: "
        + `expected exactly 2 helper config call sites, found ${helperCallMatches}.`,
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

  const supportsElicitationMatches = source.match(SUPPORTS_ELICITATION_PATTERN)?.length ?? 0;
  if (supportsElicitationMatches !== 1) {
    throw new Error(
      "Unable to patch Copilot app for SDK elicitation callbacks: "
        + `expected 1 supportsElicitation definition, found ${supportsElicitationMatches}.`,
    );
  }

  let elicitationCallbackMatches = 0;
  source = source.replace(
    ELICITATION_CALLBACK_PATTERN,
    (match, toolPlanVar) => {
      elicitationCallbackMatches++;
      return `requestElicitation:(${toolPlanVar}.toolConfig.enableRequestElicitation`
        + "||this.supportsElicitation())?";
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
