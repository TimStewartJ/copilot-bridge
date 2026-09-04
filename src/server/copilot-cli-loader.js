const ID = String.raw`[$A-Za-z_][\w$]*`;
const PARAM = String.raw`${ID}(?:=[^,()]*)?`;

// Exact contract for the stable 1.0.81 bundle. If the pinned package shape
// changes, fail validation instead of applying a partial patch.
const GITHUB_MCP_CONFIG_RESOLVER_SIGNATURE_PATTERN = new RegExp(
  String.raw`async resolveBuiltInGitHubMcpConfig\((${PARAM}(?:,${PARAM})*)\)\{`,
  "g",
);
const GITHUB_MCP_CONFIG_RESOLVER_GUARD_PATTERN = new RegExp(
  String.raw`if\(!this\.shouldInjectBuiltInGitHubMcp\((${ID})\)\|\|\1\.providerPresent\)return;`,
  "g",
);
const GITHUB_MCP_CONFIG_RESOLVER_OPTIONS_PATTERN = new RegExp(
  String.raw`(${ID})=\{\.\.\.(${ID}),copilotIntegrationId:this\.integrationId,enableMcpApps:(${ID})\}`,
  "g",
);
const GITHUB_MCP_AUTH_INFO_OPTIONS_PATTERN = new RegExp(
  String.raw`githubMcpResolveConfigForAuthInfo\(${ID},(${ID})\)`,
  "g",
);
const GITHUB_MCP_AUTH_CONTEXT_OPTIONS_PATTERN = new RegExp(
  String.raw`githubMcpResolveConfigForAuthContext\(this\.authManager\.managerConfig\(\),${ID}\.authContextId,(${ID})\)`,
  "g",
);
const GITHUB_MCP_CONFIG_RESOLVER_RETURN_PATTERN = new RegExp(
  String.raw`if\((${ID})\)return\{config:JSON\.parse\(\1\.configJson\),userOverrode:(${ID})\.userOverrode\}`,
  "g",
);
const REQUEST_ELICITATION_CAPABILITY_PATTERN = new RegExp(
  String.raw`hostSupportsElicitation:${ID}(?:\?\.|\.)requestElicitation===!0`,
  "g",
);
const REQUEST_ELICITATION_CALLBACK_PATTERN = new RegExp(
  String.raw`enableElicitationCallback:${ID}(?:\?\.|\.)requestElicitation\?\?!1`,
  "g",
);
const SUPPORTS_ELICITATION_PATTERN = new RegExp(
  String.raw`supportsElicitation\(\)\{return ${ID}\.sessionBaseSupportsCapability\(this\.nativeSessionId,"elicitation"\)\}`,
  "g",
);

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
  const methodMatches = [...source.matchAll(GITHUB_MCP_CONFIG_RESOLVER_SIGNATURE_PATTERN)];
  if (methodMatches.length !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 stable config resolver, found ${methodMatches.length}.`,
    );
  }
  const methodMatch = methodMatches[0];
  const methodStart = methodMatch.index;
  const methodOpenBrace = methodStart + methodMatch[0].length - 1;
  const methodEnd = findMatchingBrace(source, methodOpenBrace);
  if (methodEnd < 0) {
    throw new Error("Unable to patch Copilot app for Bridge GitHub MCP auth: config resolver has no matching closing brace.");
  }
  let methodSource = source.slice(methodStart, methodEnd + 1);

  let guardMatches = 0;
  let resolverOptionsVar;
  methodSource = methodSource.replace(
    GITHUB_MCP_CONFIG_RESOLVER_GUARD_PATTERN,
    (match, optionsVar) => {
      guardMatches++;
      resolverOptionsVar = optionsVar;
      return `if((!this.shouldInjectBuiltInGitHubMcp(${optionsVar})&&!(__bridgeGithubMcpOptions&&!${optionsVar}.hasGitHubToken))||${optionsVar}.providerPresent)return;`;
    },
  );
  if (guardMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 stable config resolver guard, found ${guardMatches}.`,
    );
  }
  methodSource = methodSource.replace(
    GITHUB_MCP_CONFIG_RESOLVER_SIGNATURE_PATTERN,
    `async resolveBuiltInGitHubMcpConfig(${methodMatch[1]}){const __bridgeGithubMcpOptions=${resolverOptionsVar}.githubMcpToolOptions;`,
  );

  let optionsMatches = 0;
  let resolvedOptionsVar;
  let configOptionsVar;
  methodSource = methodSource.replace(
    GITHUB_MCP_CONFIG_RESOLVER_OPTIONS_PATTERN,
    (match, optionsVar, sourceOptionsVar, mcpAppsVar) => {
      optionsMatches++;
      configOptionsVar = optionsVar;
      resolvedOptionsVar = sourceOptionsVar;
      return `${optionsVar}={...${sourceOptionsVar},copilotIntegrationId:this.integrationId,enableMcpApps:${mcpAppsVar},...__bridgeGithubMcpOptions}`;
    },
  );
  if (optionsMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 stable config options object, found ${optionsMatches}.`,
    );
  }

  const authInfoMatches = [...methodSource.matchAll(GITHUB_MCP_AUTH_INFO_OPTIONS_PATTERN)];
  const authContextMatches = [...methodSource.matchAll(GITHUB_MCP_AUTH_CONTEXT_OPTIONS_PATTERN)];
  if (
    authInfoMatches.length !== 1
    || authContextMatches.length !== 1
    || authInfoMatches[0][1] !== configOptionsVar
    || authContextMatches[0][1] !== configOptionsVar
  ) {
    throw new Error(
      "Unable to patch Copilot app for Bridge GitHub MCP auth: "
        + "stable config options do not feed both auth resolvers.",
    );
  }

  const returnMatches = [...methodSource.matchAll(GITHUB_MCP_CONFIG_RESOLVER_RETURN_PATTERN)];
  if (returnMatches.length !== 1 || returnMatches[0][2] !== resolvedOptionsVar) {
    throw new Error(
      "Unable to patch Copilot app for Bridge GitHub MCP auth: "
        + "stable config resolver return does not preserve the resolved user override.",
    );
  }
  source = source.slice(0, methodStart) + methodSource + source.slice(methodEnd + 1);

  const capabilityMatches = source.match(REQUEST_ELICITATION_CAPABILITY_PATTERN)?.length ?? 0;
  if (capabilityMatches !== 3) {
    throw new Error(
      "Unable to validate Copilot app native ask_user elicitation: "
        + `expected 3 stable capability gates, found ${capabilityMatches}.`,
    );
  }

  const supportsElicitationMatches = source.match(SUPPORTS_ELICITATION_PATTERN)?.length ?? 0;
  if (supportsElicitationMatches !== 1) {
    throw new Error(
      "Unable to validate Copilot app native ask_user elicitation: "
        + `expected 1 supportsElicitation definition, found ${supportsElicitationMatches}.`,
    );
  }

  const callbackMatches = source.match(REQUEST_ELICITATION_CALLBACK_PATTERN)?.length ?? 0;
  if (callbackMatches !== 4) {
    throw new Error(
      "Unable to validate Copilot app native ask_user elicitation: "
        + `expected 4 stable callback gates, found ${callbackMatches}.`,
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
