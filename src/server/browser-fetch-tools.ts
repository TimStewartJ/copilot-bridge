// browser_fetch — lightweight direct tool that uses agent-browser to fetch a
// page and return its accessibility-tree snapshot. Sits between web_fetch
// (pure HTTP) and the full browser skill (multi-step interactive flows).

import { randomUUID } from "node:crypto";
import type { AppContext } from "./app-context.js";
import type { BrowserCommand } from "./agent-browser.js";
import { ab, getBrowserLaunchConfig, isAgentBrowserInstalled, safeRecordBrowserSpan } from "./agent-browser.js";
import {
  getOrCreateBrowserBroker,
  type BrowserBrokerLease,
  type BrowserContext,
} from "./browser-broker.js";
import { joinFailureSections, toolFailure } from "./tool-results.js";
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

const AGENT_BROWSER_INSTALL_GUIDANCE =
  "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install";

function browserFetchFailure(
  summary: string,
  context: { url: string; selector?: string },
) {
  return toolFailure(summary, {
    sessionLog: joinFailureSections(
      `URL: ${context.url}`,
      context.selector ? `Selector: ${context.selector}` : undefined,
      summary,
    ),
  });
}

export function createBrowserFetchTools(ctx: AppContext): BridgeToolDefinition[] {
  const browserBroker = getOrCreateBrowserBroker(ctx, {
    copilotHome: ctx.copilotHome,
    telemetryStore: ctx.telemetryStore,
    getBrowserLaunchConfig: () => getBrowserLaunchConfig(ctx.settingsStore.getSettings()),
  });
  return [
    defineBridgeTool("browser_fetch", {
      description:
        "Fetch a web page using a real browser and return its content as an accessibility snapshot. " +
        "Uses a disposable unauthenticated public browser by default. Set context=authenticated only " +
        "when the page explicitly requires the dedicated signed-in Bridge profile. " +
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
        let browserSession: string | undefined;

        const check = await isAgentBrowserInstalled();
        if (!check) {
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which.failed", 0, {
            browserOpId,
            toolName: "browser_fetch",
            browserContext: context,
          });
          return toolFailure("agent-browser is not installed.", {
            detail: AGENT_BROWSER_INSTALL_GUIDANCE,
            sessionLog: AGENT_BROWSER_INSTALL_GUIDANCE,
          });
        }
        safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which", 0, {
          browserOpId,
          toolName: "browser_fetch",
          browserContext: context,
        });

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
              publicTargetId: lease.publicTargetId,
              authenticatedReason: reason || undefined,
            },
          };

          const openResult = await ab(["open", url], undefined, commandOptions);
          if (!openResult.ok) {
            return browserFetchFailure(`Failed to open URL: ${openResult.output.slice(0, 200)}`, {
              url,
              selector,
            });
          }

          const waitStart = Date.now();
          const waitResult = await ab(["wait", "--load", "networkidle"], undefined, commandOptions);
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch.wait", Date.now() - waitStart, {
            browserOpId,
            browserSession: lease.browserTarget.sessionName,
            browserContext: context,
            authenticatedReason: reason || undefined,
            publicTargetId: lease.publicTargetId,
            success: waitResult.ok,
            urlHost,
          });
          if (!waitResult.ok) {
            return browserFetchFailure(`Failed waiting for page load: ${waitResult.output.slice(0, 200)}`, {
              url,
              selector,
            });
          }

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

          const titleResult = await ab(["get", "title"], undefined, commandOptions);
          const urlResult = await ab(["get", "url"], undefined, commandOptions);

          success = true;
          return {
            url: urlResult.ok ? urlResult.output : url,
            title: titleResult.ok ? titleResult.output : undefined,
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
          return browserFetchFailure(`Browser fetch failed: ${String(err).slice(0, 200)}`, {
            url,
            selector,
          });
        } finally {
          const duration = Date.now() - toolStart;
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch", duration, {
            browserOpId,
            browserSession,
            success,
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
