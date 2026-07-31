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
// Drift canary only. These getters are native-backed from 1.0.74 onward and are
// served to the wire by the Rust runtime, so there is nothing here for Bridge to
// widen — see `patchCopilotPendingInteractionRpcSource` for why the old
// permissions-facade rewrite was dropped.
const PENDING_INTERACTION_METHODS_PATTERN = new RegExp(
  String.raw`getPendingUserInputRequests\(\)\{return ${ID}\(${ID}\.sessionPendingRequestsListJson\(this\.nativeSessionId,"userInput"\)\)\.items\}`
    + String.raw`getPendingElicitationRequests\(\)\{return ${ID}\(${ID}\.sessionPendingRequestsListJson\(this\.nativeSessionId,"elicitation"\)\)\.items`,
  "g",
);

/**
 * Asserts the runtime still owns pending interaction listing natively.
 *
 * Up to CLI 1.0.73 Bridge widened the JS `session.permissions.pendingRequests`
 * handler so a reconnecting browser could re-hydrate an in-flight `ask_user`
 * prompt. From 1.0.74 that JS object is only a client-side proxy — the wire
 * method is served natively — so the rewrite became dead code. Bridge now keeps
 * its own listing index off the runtime's `*.requested` / `*.completed` events
 * instead (see `SessionEventBus`).
 *
 * This is a contract-test canary, not a load-time gate: nothing in the patched
 * output reads these getters, so drift here should fail CI on upgrade rather
 * than refuse to launch.
 */
export function patchCopilotPendingInteractionRpcSource(source) {
  const pendingInteractionMethodMatches = source.match(PENDING_INTERACTION_METHODS_PATTERN)?.length ?? 0;
  if (pendingInteractionMethodMatches !== 1) {
    throw new Error(
      "Unable to patch Copilot app for pending interaction snapshots: "
        + `expected 1 runtime getter pair, found ${pendingInteractionMethodMatches}.`,
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

  // The native pending-getter canary is deliberately NOT enforced here: those
  // getters are runtime-owned and nothing in the patched output depends on
  // them, so a shape change must not take app-mode launch down. The
  // installed-bundle contract test asserts it instead.
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
