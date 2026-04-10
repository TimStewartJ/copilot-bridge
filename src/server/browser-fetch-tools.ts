// browser_fetch — lightweight direct tool that uses agent-browser to fetch a
// page and return its accessibility-tree snapshot. Sits between web_fetch
// (pure HTTP) and the full browser skill (multi-step interactive flows).

import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import type { AppContext } from "./app-context.js";
import type { BrowserCommand, BrowserLane } from "./agent-browser.js";
import { ab, getBridgeBrowserTarget, isAgentBrowserInstalled, safeRecordBrowserSpan, withCloneBrowserLane, withPrimaryBrowserLane } from "./agent-browser.js";

const CLONE_SAFE_BROWSER_FETCH_HOSTS = new Set([
  "example.com",
  "www.google.com",
  "www.united.com",
  "www.chase.com",
]);

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function isToolErrorResult(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function isCloneSafeBrowserFetchHost(urlHost: string | undefined): boolean {
  return !!urlHost && CLONE_SAFE_BROWSER_FETCH_HOSTS.has(urlHost);
}

export function createBrowserFetchTools(ctx: AppContext) {
  return [
    defineTool("browser_fetch", {
      description:
        "Fetch a web page using a real browser and return its content as an accessibility snapshot. " +
        "Use this to confirm rendered or canonical pages after web_search, or instead of web_fetch " +
        "when a site requires JavaScript rendering, blocks bots, returns empty/broken content via " +
        "web_fetch, or is a single-page app (SPA). For broader source discovery or parallel " +
        "research fan-out, use web_search first. For multi-step interactive flows (login, form " +
        "filling, pagination), use the browser skill instead.",
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
        },
        required: ["url"],
      },
      handler: async (args: any) => {
        const url: string = args.url;
        const selector: string | undefined = args.selector;
        const browserOpId = randomUUID();
        const primaryTarget = getBridgeBrowserTarget(ctx.copilotHome);
        const urlHost = safeHost(url);
        const toolStart = Date.now();
        let success = false;
        let laneType: "primary" | "clone" = "primary";
        let browserSession = primaryTarget.sessionName;
        let attemptedClone = false;
        let fallbackToPrimary = false;

        const check = await isAgentBrowserInstalled();
        if (!check) {
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which.failed", 0, {
            browserOpId,
            toolName: "browser_fetch",
            browserSession: primaryTarget.sessionName,
          });
          return {
            error:
              "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
          };
        }
        safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which", 0, {
          browserOpId,
          toolName: "browser_fetch",
          browserSession: primaryTarget.sessionName,
        });

        const runFlow = async (lane: BrowserLane) => {
          laneType = lane.laneType;
          browserSession = lane.browserTarget.sessionName;
          const commandOptions = {
            telemetryStore: ctx.telemetryStore,
            toolName: "browser_fetch",
            browserOpId,
            browserTarget: lane.browserTarget,
            metadata: {
              urlHost,
              selectorPresent: !!selector,
              browserLane: lane.laneType,
              cloneId: lane.cloneId,
            },
          };

          const openResult = await ab(["open", url], undefined, commandOptions);
          if (!openResult.ok) {
            return { error: `Failed to open URL: ${openResult.output.slice(0, 200)}` };
          }

          const waitStart = Date.now();
          const waitResult = await ab(["wait", "--load", "networkidle"], undefined, commandOptions);
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch.wait", Date.now() - waitStart, {
            browserOpId,
            browserSession: lane.browserTarget.sessionName,
            browserLane: lane.laneType,
            cloneId: lane.cloneId,
            success: waitResult.ok,
            urlHost,
          });
          if (!waitResult.ok) {
            return { error: `Failed waiting for page load: ${waitResult.output.slice(0, 200)}` };
          }

          const snapshotCommand: BrowserCommand = selector
            ? ["snapshot", "-i", "-s", selector]
            : ["snapshot", "-i"];
          const snapshot = await ab(snapshotCommand, undefined, commandOptions);
          if (!snapshot.ok) {
            return { error: `Failed to capture page: ${snapshot.output.slice(0, 200)}` };
          }

          const titleResult = await ab(["get", "title"], undefined, commandOptions);
          const urlResult = await ab(["get", "url"], undefined, commandOptions);

          success = true;
          return {
            url: urlResult.ok ? urlResult.output : url,
            title: titleResult.ok ? titleResult.output : undefined,
            snapshot: snapshot.output,
          };
        };

        try {
          if (isCloneSafeBrowserFetchHost(urlHost)) {
            attemptedClone = true;
            try {
              const cloneResult = await withCloneBrowserLane(ctx.copilotHome, ctx.telemetryStore, {
                browserOpId,
                toolName: "browser_fetch",
                urlHost,
              }, runFlow);
              if (!isToolErrorResult(cloneResult)) {
                return cloneResult;
              }
              fallbackToPrimary = true;
              safeRecordBrowserSpan(ctx.telemetryStore, "browser.clone.fallback_to_primary", 0, {
                browserOpId,
                toolName: "browser_fetch",
                urlHost,
                reason: "tool_error",
              });
            } catch (err) {
              fallbackToPrimary = true;
              safeRecordBrowserSpan(ctx.telemetryStore, "browser.clone.fallback_to_primary", 0, {
                browserOpId,
                toolName: "browser_fetch",
                urlHost,
                reason: "exception",
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          return await withPrimaryBrowserLane(ctx.copilotHome, ctx.telemetryStore, {
            browserOpId,
            toolName: "browser_fetch",
            urlHost,
          }, runFlow);
        } catch (err: any) {
          return { error: `Browser fetch failed: ${String(err).slice(0, 200)}` };
        } finally {
          const duration = Date.now() - toolStart;
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch", duration, {
            browserOpId,
            browserSession,
            success,
            urlHost,
            selectorPresent: !!selector,
            browserLane: laneType,
            attemptedClone,
            fallbackToPrimary,
          });
          if (!success) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch.failed", duration, {
              browserOpId,
              browserSession,
              urlHost,
              browserLane: laneType,
              attemptedClone,
              fallbackToPrimary,
            });
          }
        }
      },
    }),
  ];
}
