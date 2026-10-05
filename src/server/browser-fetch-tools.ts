// browser_fetch — lightweight direct tool that uses agent-browser to fetch a
// page and return its accessibility-tree snapshot. Sits between web_fetch
// (pure HTTP) and the full browser skill (multi-step interactive flows).

import { randomUUID } from "node:crypto";
import type { AppContext } from "./app-context.js";
import type { BrowserCommand } from "./agent-browser.js";
import { ab, safeRecordBrowserSpan } from "./agent-browser.js";
import { agentBrowserMissingFailure } from "./browser-automation.js";
import type { BrowserBrokerLease, BrowserContext } from "./browser-broker.js";
import { getBrowserRuntime } from "./browser-runtime.js";
import { checkPage, pageBlockFields, type PageBlockFields } from "./browser-page-check.js";
import { joinFailureSections, toolFailure, toolFailureWithContext } from "./tool-results.js";
import { defineBridgeTool, registerBridgeToolDefinitions } from "./agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition } from "./agent-tools-mcp/server.js";
import type { BridgeToolsMcpServer } from "./agent-tools-mcp/server.js";

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function browserFetchFailure(
  summary: string,
  context: { url: string; selector?: string },
  pageBlock: PageBlockFields = {},
) {
  return toolFailureWithContext(summary, pageBlock, {
    // A failure reaches the agent as its text alone, so what the page turned out to be goes there.
    detail: (pageBlock.blocked ?? pageBlock.captcha)?.guidance,
    sessionLog: joinFailureSections(
      `URL: ${context.url}`,
      context.selector ? `Selector: ${context.selector}` : undefined,
      summary,
    ),
  });
}

export function createBrowserFetchTools(ctx: AppContext): BridgeToolDefinition[] {
  const browserBroker = getBrowserRuntime(ctx).broker;
  return [
    defineBridgeTool("browser_fetch", {
      description:
        "Fetch a web page using a real browser and return its content as an accessibility snapshot. " +
        "Uses the public browser by default, which is not signed in to anything and keeps its cookies " +
        "between uses. Set context=authenticated only " +
        "when the page explicitly requires the dedicated signed-in Bridge profile. " +
        "When a site answers with a human check or a refusal instead of the page, the result says so in " +
        "`blocked` with what to do next. " +
        "Use this to confirm rendered or canonical pages after web_search or browser_web_search, or instead of web_fetch " +
        "when a site requires JavaScript rendering, blocks bots, returns empty/broken content via " +
        "web_fetch, or is a single-page app (SPA). For multi-step interactive flows, use browser_exec " +
        "or browser_session_* with an explicit context. Use the browser skill only for unsupported low-level public workflows.",
      parameters: {
        type: "object" as const,
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          selector: {
            type: "string",
            description:
              "Optional CSS selector to scope the snapshot to a specific part of the page (e.g., 'main', '#content', 'article')",
          },
          context: {
            type: "string",
            enum: ["public", "authenticated"],
            description: "Browser security context. Defaults to public.",
          },
          reason: {
            type: "string",
            description: "Required justification when context is authenticated.",
          },
        },
        required: ["url"],
      },
      handler: async (args: any) => {
        const url: string = args.url;
        const selector: string | undefined = args.selector;
        const context: BrowserContext = args.context ?? "public";
        if (context !== "public" && context !== "authenticated") {
          return toolFailure("context must be public or authenticated");
        }
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        if (context === "authenticated" && !reason) {
          return toolFailure("reason is required for authenticated browser access");
        }
        const browserOpId = randomUUID();
        const urlHost = safeHost(url);
        const toolStart = Date.now();
        let success = false;
        let blockKind: string | undefined;
        let browserSession: string | undefined;

        const missing = await agentBrowserMissingFailure();
        if (missing) return missing;

        const runFlow = async (lease: BrowserBrokerLease) => {
          browserSession = lease.browserTarget.sessionName;
          const commandOptions = {
            telemetryStore: ctx.telemetryStore,
            toolName: "browser_fetch",
            browserOpId,
            browserTarget: lease.browserTarget,
            metadata: {
              urlHost,
              selectorPresent: !!selector,
              browserContext: context,
              publicSlot: lease.publicSlot,
              authenticatedReason: reason || undefined,
            },
          };

          const openResult = await ab(["open", url], undefined, commandOptions);
          if (!openResult.ok) {
            // A refusal without a body fails the navigation and still leaves a page that says so.
            return browserFetchFailure(`Failed to open URL: ${openResult.output.slice(0, 200)}`, {
              url,
              selector,
            }, pageBlockFields(await checkPage(commandOptions)));
          }

          // One command waits for the page to stop changing and reads what kind of page it is.
          const waitStart = Date.now();
          const pageCheck = await checkPage(commandOptions, { settle: true });
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch.wait", Date.now() - waitStart, {
            browserOpId,
            browserSession: lease.browserTarget.sessionName,
            browserContext: context,
            authenticatedReason: reason || undefined,
            publicSlot: lease.publicSlot,
            success: !!pageCheck.signals,
            urlHost,
          });

          const snapshotCommand: BrowserCommand = selector
            ? ["snapshot", "-i", "-s", selector]
            : ["snapshot", "-i"];
          const snapshot = await ab(snapshotCommand, undefined, commandOptions);
          if (!snapshot.ok) {
            return browserFetchFailure(`Failed to capture page: ${snapshot.output.slice(0, 200)}`, {
              url,
              selector,
            });
          }

          // The check reads both already; the separate commands are for a page it could not read.
          const pageUrl = pageCheck.signals?.url ?? await ab(["get", "url"], undefined, commandOptions)
            .then((result) => (result.ok ? result.output : url));
          const pageTitle = pageCheck.signals?.title ?? await ab(["get", "title"], undefined, commandOptions)
            .then((result) => (result.ok ? result.output : undefined));

          success = true;
          blockKind = pageCheck.block?.kind;
          return {
            ...pageBlockFields(pageCheck),
            url: pageUrl,
            title: pageTitle,
            snapshot: snapshot.output,
            context,
          };
        };

        try {
          return await browserBroker.withEphemeralContext(context, {
            browserOpId,
            toolName: "browser_fetch",
            metadata: {
              browserOpId,
              browserContext: context,
              authenticatedReason: reason || undefined,
              urlHost,
            },
          }, runFlow);
        } catch (err: any) {
          return browserFetchFailure(`Browser fetch failed: ${String(err).slice(0, 400)}`, {
            url,
            selector,
          });
        } finally {
          const duration = Date.now() - toolStart;
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch", duration, {
            browserOpId,
            browserSession,
            success,
            blockKind,
            urlHost,
            selectorPresent: !!selector,
            browserContext: context,
            authenticatedReason: reason || undefined,
          });
          if (!success) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch.failed", duration, {
              browserOpId,
              browserSession,
              urlHost,
              browserContext: context,
            });
          }
        }
      },
    }),
  ];
}

export function registerBrowserFetchTools(server: BridgeToolsMcpServer, ctx: AppContext): void {
  registerBridgeToolDefinitions(server, createBrowserFetchTools(ctx));
}
