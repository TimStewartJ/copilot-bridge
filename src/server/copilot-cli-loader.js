const ID = String.raw`[$A-Za-z_][\w$]*`;
const PARAM = String.raw`${ID}(?:=[^,()]*)?`;

// Exact contract for the stable 1.0.80 bundle. If the pinned package shape
// changes, fail validation instead of applying a partial patch.
const GITHUB_MCP_CONFIG_RESOLVER_SIGNATURE_PATTERN = new RegExp(
  String.raw`async resolveBuiltInGitHubMcpConfig\((${PARAM}(?:,${PARAM})*)\)\{`,
  "g",
);
const GITHUB_MCP_CONFIG_RESOLVER_GUARD_PATTERN = new RegExp(
  String.raw`if\(!this\.shouldInjectBuiltInGitHubMcp\((${ID})\)\|\|!(${ID})\|\|\1\.provider\)return;`,
  "g",
);
const GITHUB_MCP_CONFIG_RESOLVER_RETURN_PATTERN = new RegExp(
  String.raw`return\{config:(${ID})\((${ID}),(${ID}),(\{[^{}]*\})((?:,${ID}){1,2})\),userOverrode:(${ID})\.userOverrode\}`,
  "g",
);
const ASK_USER_ELICITATION_PATTERN = new RegExp(
  String.raw`let (${ID})=!!(${ID})\.requestUserInput,(${ID})=!!\2\.featureFlags\?\.ASK_USER_ELICITATION&&!!\2\.requestElicitation;`,
  "g",
);
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
    (match, optionsVar, authVar) => {
      guardMatches++;
      resolverOptionsVar = optionsVar;
      return `if((!this.shouldInjectBuiltInGitHubMcp(${optionsVar})&&!(__bridgeGithubMcpOptions&&!${optionsVar}.gitHubToken))||!${authVar}||${optionsVar}.provider)return;`;
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

  let returnMatches = 0;
  methodSource = methodSource.replace(
    GITHUB_MCP_CONFIG_RESOLVER_RETURN_PATTERN,
    (match, configBuilder, tokenVar, authParam, configObject, trailingArgs, userOverrideVar) => {
      returnMatches++;
      const patchedConfigObject = configObject === "{}"
        ? "{...__bridgeGithubMcpOptions}"
        : `${configObject.slice(0, -1)},...__bridgeGithubMcpOptions}`;
      return `return{config:${configBuilder}(${tokenVar},${authParam},${patchedConfigObject}${trailingArgs}),userOverrode:${userOverrideVar}.userOverrode}`;
    },
  );
  if (returnMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 stable config resolver return, found ${returnMatches}.`,
    );
  }
  source = source.slice(0, methodStart) + methodSource + source.slice(methodEnd + 1);

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
      `Unable to patch Copilot app for native ask_user elicitation: expected 1 stable tool-selection gate, found ${askUserMatches}.`,
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
      `Unable to patch Copilot app for SDK elicitation callbacks: expected 1 stable callback gate, found ${elicitationCallbackMatches}.`,
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
