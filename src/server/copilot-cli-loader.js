// Minified JS identifiers can legally contain "$" (and "_"), which the Copilot
// bundle's minifier uses for some helper names (e.g. "$R"). Match the full set
// of valid identifier characters so pattern matching survives minifier renames.
const ID = String.raw`[$A-Za-z_][\w$]*`;
// The resolver signature carries a defaulted parameter (`o=!1`), so parameters
// are not bare identifiers. Only comma- and paren-free defaults are accepted: a
// default containing either character fails the whole signature match, which
// surfaces as a loud drift error instead of a silently mis-captured parameter
// list.
const PARAM = String.raw`${ID}(?:=[^,()]*)?`;

// Copilot CLI >= 1.0.81 (the pinned channel, see copilot-cli.lock.json) resolves
// the session auth natively: the GitHub MCP resolver receives the normalized
// session.create/resume params (`hasGitHubToken`, `providerPresent`) and builds
// the GitHub MCP config through a native call that takes the merged tool options
// object. Bridge's `githubMcpToolOptions` arrives on that params object (the
// host-construct path forwards unknown wire fields), so the patch widens the
// injection guard and spreads the Bridge options into the config builder
// argument without touching the native `githubMcpToolConfig` session layer,
// which would flip `userOverrode` and re-enable the gh-overlap tools.
const GITHUB_MCP_CONFIG_RESOLVER_SIGNATURE_PATTERN = new RegExp(
  String.raw`async resolveBuiltInGitHubMcpConfig\((${PARAM}(?:,${PARAM})*)\)\{`,
  "g",
);
const GITHUB_MCP_CONFIG_NATIVE_AUTH_GUARD_PATTERN = new RegExp(
  String.raw`if\(!this\.shouldInjectBuiltInGitHubMcp\((${ID})\)\|\|\1\.providerPresent\)return;`,
  "g",
);
const GITHUB_MCP_CONFIG_NATIVE_AUTH_CONFIG_CALL_PATTERN = new RegExp(
  String.raw`\{\.\.\.(${ID}),copilotIntegrationId:this\.integrationId,enableMcpApps:(${ID})\}\)`,
  "g",
);
const GITHUB_MCP_CONFIG_NATIVE_AUTH_RETURN_PATTERN = new RegExp(
  String.raw`return\{config:JSON\.parse\((${ID})\.configJson\),userOverrode:(${ID})\.userOverrode\}`,
  "g",
);
// The host's elicitation capability is handed to the native session plan, which
// is what makes Bridge's transport-answered `ask_user` work without JS patches.
// Its absence means the bundle is not the CLI generation this loader targets.
const NATIVE_ELICITATION_CAPABILITY_PATTERN = /hostSupportsElicitation:/g;

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
    throw new Error(`Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 config resolver, found ${methodMatches.length}.`);
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
    GITHUB_MCP_CONFIG_NATIVE_AUTH_GUARD_PATTERN,
    (match, optionsVar) => {
      guardMatches++;
      resolverOptionsVar = optionsVar;
      return `if((!this.shouldInjectBuiltInGitHubMcp(${optionsVar})&&!(__bridgeGithubMcpOptions&&!${optionsVar}.hasGitHubToken))||${optionsVar}.providerPresent)return;`;
    },
  );
  if (guardMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 native config resolver guard, found ${guardMatches}.`,
    );
  }
  methodSource = methodSource.replace(
    GITHUB_MCP_CONFIG_RESOLVER_SIGNATURE_PATTERN,
    `async resolveBuiltInGitHubMcpConfig(${methodMatch[1]}){const __bridgeGithubMcpOptions=${resolverOptionsVar}.githubMcpToolOptions;`,
  );

  let configCallMatches = 0;
  methodSource = methodSource.replace(
    GITHUB_MCP_CONFIG_NATIVE_AUTH_CONFIG_CALL_PATTERN,
    (match, toolOptionsVar, mcpAppsVar) => {
      configCallMatches++;
      return `{...${toolOptionsVar},copilotIntegrationId:this.integrationId,enableMcpApps:${mcpAppsVar},...__bridgeGithubMcpOptions})`;
    },
  );
  if (configCallMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 native config call, found ${configCallMatches}.`,
    );
  }
  const returnMatches = [...methodSource.matchAll(GITHUB_MCP_CONFIG_NATIVE_AUTH_RETURN_PATTERN)].length;
  if (returnMatches !== 1) {
    throw new Error(
      `Unable to patch Copilot app for Bridge GitHub MCP auth: expected 1 native config resolver return, found ${returnMatches}.`,
    );
  }
  source = source.slice(0, methodStart) + methodSource + source.slice(methodEnd + 1);

  const nativeElicitationMatches = source.match(NATIVE_ELICITATION_CAPABILITY_PATTERN)?.length ?? 0;
  if (nativeElicitationMatches === 0) {
    throw new Error(
      "Unable to patch Copilot app for native ask_user elicitation: the bundle does not pass hostSupportsElicitation to the native session plan.",
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