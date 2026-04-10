// browser_fetch — lightweight direct tool that uses agent-browser to fetch a
// page and return its accessibility-tree snapshot. Sits between web_fetch
// (pure HTTP) and the full browser skill (multi-step interactive flows).

import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import type { AppContext } from "./app-context.js";
import type { BrowserCommand } from "./agent-browser.js";
import { ab, getBridgeBrowserTarget, recordBrowserSpan, run, withBridgeBrowserSession } from "./agent-browser.js";

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function createBrowserFetchTools(ctx: AppContext) {
  return [
    defineTool("browser_fetch", {
      description:
        "Fetch a web page using a real browser and return its content as an accessibility snapshot. " +
        "Use this instead of web_fetch when a site requires JavaScript rendering, blocks bots, " +
        "returns empty/broken content via web_fetch, or is a single-page app (SPA). " +
        "For multi-step interactive flows (login, form filling, pagination), use the browser skill instead.",
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
        const browserTarget = getBridgeBrowserTarget(ctx.copilotHome);
        const urlHost = safeHost(url);
        const toolStart = Date.now();
        let success = false;

        const check = await run("which agent-browser");
        if (!check.ok) {
          recordBrowserSpan(ctx.telemetryStore, "browser.command.which.failed", 0, {
            browserOpId,
            toolName: "browser_fetch",
            browserSession: browserTarget.sessionName,
          });
          return {
            error:
              "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
          };
        }
        recordBrowserSpan(ctx.telemetryStore, "browser.command.which", 0, {
          browserOpId,
          toolName: "browser_fetch",
          browserSession: browserTarget.sessionName,
        });

        try {
          return await withBridgeBrowserSession(browserTarget, async () => {
            const commandOptions = {
              telemetryStore: ctx.telemetryStore,
              toolName: "browser_fetch",
              browserOpId,
              browserTarget,
              metadata: { urlHost, selectorPresent: !!selector },
            };

            const openResult = await ab(["open", url], undefined, commandOptions);
            if (!openResult.ok) {
              return { error: `Failed to open URL: ${openResult.output.slice(0, 200)}` };
            }

            const waitStart = Date.now();
            const waitResult = await ab(["wait", "--load", "networkidle"], undefined, commandOptions);
            recordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch.wait", Date.now() - waitStart, {
              browserOpId,
              browserSession: browserTarget.sessionName,
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
          });
        } catch (err: any) {
          return { error: `Browser fetch failed: ${String(err).slice(0, 200)}` };
        } finally {
          const duration = Date.now() - toolStart;
          recordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch", duration, {
            browserOpId,
            browserSession: browserTarget.sessionName,
            success,
            urlHost,
            selectorPresent: !!selector,
          });
          if (!success) {
            recordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_fetch.failed", duration, {
              browserOpId,
              browserSession: browserTarget.sessionName,
              urlHost,
            });
          }
        }
      },
    }),
  ];
}
