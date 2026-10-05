// Browser web search tool — uses agent-browser to search Google, Bing, then DuckDuckGo.
// Returns an accessibility-tree snapshot of the results page for the LLM to interpret,
// avoiding fragile CSS selectors that break when search engines change their DOM.

import { createHash, randomUUID } from "node:crypto";
import type { AppContext } from "./app-context.js";
import type { BrowserCommand } from "./agent-browser.js";
import { ab, safeRecordBrowserSpan } from "./agent-browser.js";
import { agentBrowserMissingFailure } from "./browser-automation.js";
import type { BrowserBrokerLease } from "./browser-broker.js";
import { getBrowserRuntime } from "./browser-runtime.js";
import { checkPage } from "./browser-page-check.js";
import { joinFailureSections, toolFailure } from "./tool-results.js";
import { defineBridgeTool, registerBridgeToolDefinitions } from "./agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition } from "./agent-tools-mcp/server.js";
import type { BridgeToolsMcpServer } from "./agent-tools-mcp/server.js";

async function takeSnapshot(
  selector: string | undefined,
  commandOptions: Parameters<typeof ab>[2],
): Promise<{ ok: boolean; output: string }> {
  const command: BrowserCommand = selector ? ["snapshot", "-i", "-s", selector] : ["snapshot", "-i"];
  return ab(command, undefined, commandOptions);
}

function hasResults(snapshot: string): boolean {
  const linkCount = (snapshot.match(/^- link /gm) || []).length;
  const headingCount = (snapshot.match(/heading /gm) || []).length;
  return linkCount >= 3 && headingCount >= 2;
}

function isGoogleCaptchaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)google\./i.test(parsed.hostname) && parsed.pathname.startsWith("/sorry");
  } catch {
    return /google\.[^/\s]+\/sorry/i.test(url);
  }
}

function isBingCaptchaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return /(^|\.)bing\.com$/.test(hostname)
      && (pathname.includes("captcha") || pathname.includes("challenge") || pathname.includes("turing"));
  } catch {
    return /bing\.[^/\s]+\/[^\s]*(?:captcha|challenge|turing)/i.test(url);
  }
}

function queryFingerprint(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 12);
}

const PROVIDER_CAPTCHA_COOLDOWN_MS = 15 * 60 * 1000;
const ALL_PROVIDERS_EXHAUSTED_GUIDANCE =
  "All browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.";
const ALL_PROVIDERS_COOLDOWN_GUIDANCE =
  "All browser web search providers are blocked by challenge verification or cooling down. Do not retry browser_web_search until the cooldown expires; use a different research tool/source or ask the user to resolve the browser challenges.";

type SearchProviderId = "google" | "bing" | "duckduckgo";
type SearchProviderTelemetryKey = "google" | "bing" | "duckduckgo";

interface SearchProvider {
  id: SearchProviderId;
  telemetryKey: SearchProviderTelemetryKey;
  source: string;
  label: string;
  resultsSelector?: string;
  openFailureCode: string;
  challengeFailureCode: string;
  noResultsFailureCode: string;
  getUrl: (query: string) => string;
  isCaptchaUrl?: (url: string) => boolean;
  challengeFailure: string;
  noResultsFailure: string;
}

interface SearchProviderSuccess {
  ok: true;
  source: string;
  query: string;
  url: string;
  snapshot: string;
}

interface SearchProviderFailure {
  ok: false;
  summary: string;
  challenge: boolean;
}

const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  {
    id: "google",
    telemetryKey: "google",
    source: "google",
    label: "Google",
    resultsSelector: "#rso",
    openFailureCode: "navigation.open_failed",
    challengeFailureCode: "search.google_captcha",
    noResultsFailureCode: "search.google_no_results",
    getUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    isCaptchaUrl: isGoogleCaptchaUrl,
    challengeFailure: "Google requires captcha verification before search results can be returned.",
    noResultsFailure: "Google did not return recognizable search results.",
  },
  {
    id: "bing",
    telemetryKey: "bing",
    source: "bing",
    label: "Bing",
    resultsSelector: "#b_results",
    openFailureCode: "search.bing_failed",
    challengeFailureCode: "search.bing_captcha",
    noResultsFailureCode: "search.bing_no_results",
    getUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    isCaptchaUrl: isBingCaptchaUrl,
    challengeFailure: "Bing requires captcha verification before search results can be returned.",
    noResultsFailure: "Bing did not return recognizable search results.",
  },
  {
    id: "duckduckgo",
    telemetryKey: "duckduckgo",
    source: "duckduckgo",
    label: "DuckDuckGo",
    openFailureCode: "search.ddg_failed",
    challengeFailureCode: "search.ddg_challenge",
    noResultsFailureCode: "search.ddg_no_results",
    getUrl: (query) => `https://duck.com/?q=${encodeURIComponent(query)}&ia=web`,
    challengeFailure: "DuckDuckGo requires challenge verification before search results can be returned.",
    noResultsFailure: "DuckDuckGo did not return recognizable search results.",
  },
];

const providerCaptchaCooldowns = new Map<SearchProviderId, number>();

function providerSpanName(provider: SearchProvider, suffix?: "failed" | "skipped"): string {
  return `browser.tool.browser_web_search.${provider.telemetryKey}${suffix ? `.${suffix}` : ""}`;
}

function getProviderCooldownUntil(provider: SearchProvider, now = Date.now()): number | undefined {
  const cooldownUntil = providerCaptchaCooldowns.get(provider.id);
  if (cooldownUntil === undefined) return undefined;
  if (cooldownUntil <= now) {
    providerCaptchaCooldowns.delete(provider.id);
    return undefined;
  }
  return cooldownUntil;
}

function startProviderCooldown(provider: SearchProvider, now = Date.now()): number {
  const cooldownUntil = now + PROVIDER_CAPTCHA_COOLDOWN_MS;
  providerCaptchaCooldowns.set(provider.id, cooldownUntil);
  return cooldownUntil;
}

function formatCooldownRemaining(cooldownUntil: number, now = Date.now()): string {
  const remainingSeconds = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
  if (remainingSeconds < 60) return `${remainingSeconds}s`;
  return `${Math.ceil(remainingSeconds / 60)}m`;
}

function cooldownSummary(provider: SearchProvider, cooldownUntil: number, now = Date.now()): string {
  return `${provider.label} is cooling down after a recent captcha/challenge. It will be skipped for ${formatCooldownRemaining(cooldownUntil, now)}.`;
}

function webSearchFailure(
  summary: string,
  context: { query: string; source?: string; priorFailure?: string },
) {
  return toolFailure(summary, {
    sessionLog: joinFailureSections(
      context.source ? `Search engine: ${context.source}` : undefined,
      `Query: ${context.query}`,
      context.priorFailure,
      summary,
    ),
  });
}

export function createWebSearchTools(ctx: AppContext): BridgeToolDefinition[] {
  const browserBroker = getBrowserRuntime(ctx).broker;
  return [
    defineBridgeTool("browser_web_search", {
      description:
        "Search the web using the public browser, which is not signed in to anything. Returns ranked search-engine results from Google with " +
        "automatic Bing and DuckDuckGo fallbacks. Use this when web_search is unavailable or failing, " +
        "or when direct browser-backed search-engine verification is specifically needed. " +
        "After identifying promising results, " +
        "follow up with browser_fetch when you need rendered-page confirmation or the canonical " +
        "source. Requires agent-browser to be installed.",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
        },
        required: ["query"],
      },
      handler: async (args: any) => {
        const query: string = args.query;
        const browserOpId = randomUUID();
        const queryHash = queryFingerprint(query);
        const queryLength = query.length;
        const toolStart = Date.now();
        let success = false;
        let source: string | undefined;
        let browserSession: string | undefined;

        const missing = await agentBrowserMissingFailure();
        if (missing) return missing;
        const runFlow = async (lease: BrowserBrokerLease) => {
          browserSession = lease.browserTarget.sessionName;
          const commandOptions = {
            telemetryStore: ctx.telemetryStore,
            toolName: "browser_web_search",
            browserOpId,
            browserTarget: lease.browserTarget,
            metadata: {
              queryHash,
              queryLength,
              browserContext: "public",
              publicSlot: lease.publicSlot,
            },
          };

          const providerTelemetry = (provider: SearchProvider, extra: Record<string, unknown> = {}) => ({
            browserOpId,
            browserSession: lease.browserTarget.sessionName,
            browserContext: "public",
            publicSlot: lease.publicSlot,
            queryHash,
            ...extra,
          });

          const recordFallback = (fromProvider: SearchProvider, toProvider: SearchProvider) => {
            console.log(`[browser] ${JSON.stringify({
              event: "browser_web_search.fallback",
              browserOpId,
              browserSession: lease.browserTarget.sessionName,
              browserContext: "public",
              publicSlot: lease.publicSlot,
              from: fromProvider.source,
              to: toProvider.source,
              queryHash,
              queryLength,
            })}`);
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_web_search.fallback", 0, {
              browserOpId,
              browserSession: lease.browserTarget.sessionName,
              browserContext: "public",
              publicSlot: lease.publicSlot,
              from: fromProvider.source,
              to: toProvider.source,
              queryHash,
            });
          };

          const recordFailure = (
            provider: SearchProvider,
            duration: number,
            failureCode: string,
            extra: Record<string, unknown> = {},
          ) => {
            safeRecordBrowserSpan(ctx.telemetryStore, providerSpanName(provider, "failed"), duration, providerTelemetry(provider, {
              failureCode,
              ...extra,
            }));
          };

          const searchProvider = async (provider: SearchProvider): Promise<SearchProviderSuccess | SearchProviderFailure> => {
            const providerUrl = provider.getUrl(query);
            const providerStart = Date.now();
            const open = await ab(["open", providerUrl], undefined, commandOptions);
            if (!open.ok) {
              recordFailure(provider, Date.now() - providerStart, provider.openFailureCode);
              return {
                ok: false,
                challenge: false,
                summary: open.output
                  ? `Failed to open ${provider.label}: ${open.output.slice(0, 200)}`
                  : `Failed to open ${provider.label}.`,
              };
            }

            // Waits for the results to stop changing and reads whether the page is a check instead.
            const pageCheck = await checkPage(commandOptions, { settle: true });
            const isChallenge = (pageCheck.block && pageCheck.block.kind !== "captcha")
              || (!!pageCheck.signals && provider.isCaptchaUrl?.(pageCheck.signals.url) === true);
            if (isChallenge) {
              recordFailure(provider, Date.now() - providerStart, provider.challengeFailureCode);
              return {
                ok: false,
                challenge: true,
                summary: provider.challengeFailure,
              };
            }

            const snapshot = await takeSnapshot(provider.resultsSelector, commandOptions);
            const providerDuration = Date.now() - providerStart;
            safeRecordBrowserSpan(ctx.telemetryStore, providerSpanName(provider), providerDuration, providerTelemetry(provider, {
              success: snapshot.ok && hasResults(snapshot.output),
            }));

            if (!snapshot.ok) {
              recordFailure(provider, providerDuration, "extraction.snapshot_failed");
              return {
                ok: false,
                challenge: false,
                summary: `Failed to capture ${provider.label} results: ${snapshot.output.slice(0, 200)}`,
              };
            }

            if (!hasResults(snapshot.output)) {
              recordFailure(provider, providerDuration, provider.noResultsFailureCode);
              return {
                ok: false,
                challenge: false,
                summary: provider.noResultsFailure,
              };
            }

            return {
              ok: true,
              source: provider.source,
              query,
              url: providerUrl,
              snapshot: snapshot.output,
            };
          };

          let priorFailure: string | undefined;
          let lastFailure: string | undefined;
          let lastAttemptedProvider: SearchProvider | undefined;
          let attemptedProviderCount = 0;
          let challengeFailureCount = 0;
          let cooldownSkipCount = 0;

          const rememberFailure = (provider: SearchProvider, summary: string) => {
            if (lastFailure) priorFailure = joinFailureSections(priorFailure, lastFailure);
            lastFailure = summary;
          };

          for (const provider of SEARCH_PROVIDERS) {
            const cooldownUntil = getProviderCooldownUntil(provider);
            if (cooldownUntil !== undefined) {
              cooldownSkipCount += 1;
              const summary = cooldownSummary(provider, cooldownUntil);
              safeRecordBrowserSpan(ctx.telemetryStore, providerSpanName(provider, "skipped"), 0, providerTelemetry(provider, {
                reason: "captcha_cooldown",
                cooldownUntil: new Date(cooldownUntil).toISOString(),
                cooldownRemainingMs: Math.max(0, cooldownUntil - Date.now()),
              }));
              rememberFailure(provider, summary);
              continue;
            }

            if (lastAttemptedProvider) recordFallback(lastAttemptedProvider, provider);
            attemptedProviderCount += 1;
            const result = await searchProvider(provider);
            if (result.ok) {
              source = result.source;
              success = true;
              return result;
            }

            let summary = result.summary;
            if (result.challenge) {
              challengeFailureCount += 1;
              const cooldownUntil = startProviderCooldown(provider);
              summary = `${summary} ${provider.label} will be skipped for ${formatCooldownRemaining(cooldownUntil)}.`;
            }
            rememberFailure(provider, summary);
            lastAttemptedProvider = provider;
          }

          if (attemptedProviderCount === 0 && cooldownSkipCount === SEARCH_PROVIDERS.length) {
            return webSearchFailure(ALL_PROVIDERS_COOLDOWN_GUIDANCE, {
              query,
              priorFailure: joinFailureSections(priorFailure, lastFailure),
            });
          }
          if (
            attemptedProviderCount > 0
            && challengeFailureCount === attemptedProviderCount
            && attemptedProviderCount + cooldownSkipCount === SEARCH_PROVIDERS.length
          ) {
            return webSearchFailure(ALL_PROVIDERS_COOLDOWN_GUIDANCE, {
              query,
              priorFailure: joinFailureSections(priorFailure, lastFailure),
            });
          }

          return webSearchFailure(ALL_PROVIDERS_EXHAUSTED_GUIDANCE, {
            query,
            priorFailure: joinFailureSections(priorFailure, lastFailure),
          });
        };

        try {
          return await browserBroker.withEphemeralContext("public", {
            browserOpId,
            toolName: "browser_web_search",
            metadata: {
              browserOpId,
              browserContext: "public",
              queryHash,
            },
          }, runFlow);
        } catch (err: any) {
          return webSearchFailure(`Search failed: ${String(err).slice(0, 400)}`, { query });
        } finally {
          const duration = Date.now() - toolStart;
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_web_search", duration, {
            browserOpId,
            browserSession,
            success,
            source,
            queryHash,
            queryLength,
            browserContext: "public",
          });
          if (!success) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_web_search.failed", duration, {
              browserOpId,
              browserSession,
              queryHash,
              browserContext: "public",
            });
          }
        }
      },
    }),
  ];
}

export function registerWebSearchTools(server: BridgeToolsMcpServer, ctx: AppContext): void {
  registerBridgeToolDefinitions(server, createWebSearchTools(ctx));
}
