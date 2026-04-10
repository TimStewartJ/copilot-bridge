// Web search tool — uses agent-browser to search Google (with DuckDuckGo fallback).
// Returns an accessibility-tree snapshot of the results page for the LLM to interpret,
// avoiding fragile CSS selectors that break when search engines change their DOM.

import { createHash, randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import type { AppContext } from "./app-context.js";
import type { BrowserCommand, BrowserLane } from "./agent-browser.js";
import { ab, getBridgeBrowserTarget, isAgentBrowserInstalled, safeRecordBrowserSpan, withCloneBrowserLane, withPrimaryBrowserLane } from "./agent-browser.js";

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

function queryFingerprint(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 12);
}

function isToolErrorResult(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

export function createWebSearchTools(ctx: AppContext) {
  return [
    defineTool("web_search", {
      description:
        "Search the web using a real browser. Returns structured results (title, URL, snippet) " +
        "from Google with automatic DuckDuckGo fallback. Use this when you need to find current " +
        "information, look up documentation, research topics, or answer questions that require " +
        "up-to-date web knowledge. Requires agent-browser to be installed.",
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
        const primaryTarget = getBridgeBrowserTarget(ctx.copilotHome);
        const queryHash = queryFingerprint(query);
        const queryLength = query.length;
        const toolStart = Date.now();
        let success = false;
        let source: string | undefined;
        let laneType: "primary" | "clone" = "primary";
        let browserSession = primaryTarget.sessionName;
        let attemptedClone = false;
        let fallbackToPrimary = false;

        const check = await isAgentBrowserInstalled();
        if (!check) {
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which.failed", 0, {
            browserOpId,
            toolName: "web_search",
            browserSession: primaryTarget.sessionName,
            queryHash,
          });
          return {
            error:
              "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
          };
        }
        safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which", 0, {
          browserOpId,
          toolName: "web_search",
          browserSession: primaryTarget.sessionName,
          queryHash,
        });

        const runFlow = async (lane: BrowserLane) => {
          laneType = lane.laneType;
          browserSession = lane.browserTarget.sessionName;
          const commandOptions = {
            telemetryStore: ctx.telemetryStore,
            toolName: "web_search",
            browserOpId,
            browserTarget: lane.browserTarget,
            metadata: {
              queryHash,
              queryLength,
              browserLane: lane.laneType,
              cloneId: lane.cloneId,
            },
          };

          const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          const googleStart = Date.now();
          const googleOpen = await ab(["open", googleUrl], undefined, commandOptions);

          if (googleOpen.ok) {
            const googleWait = await ab(["wait", "--load", "networkidle"], undefined, commandOptions);
            if (googleWait.ok) {
              const snapshot = await takeSnapshot("#rso", commandOptions);
              const googleDuration = Date.now() - googleStart;
              safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.google", googleDuration, {
                browserOpId,
                browserSession: lane.browserTarget.sessionName,
                browserLane: lane.laneType,
                cloneId: lane.cloneId,
                queryHash,
                success: snapshot.ok && hasResults(snapshot.output),
              });

              if (snapshot.ok && hasResults(snapshot.output)) {
                source = "google";
                success = true;
                return {
                  source,
                  query,
                  url: googleUrl,
                  snapshot: snapshot.output,
                };
              }
            } else {
              safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.google.failed", Date.now() - googleStart, {
                browserOpId,
                browserSession: lane.browserTarget.sessionName,
                browserLane: lane.laneType,
                cloneId: lane.cloneId,
                queryHash,
                failureCode: "navigation.wait_networkidle_timeout",
              });
            }
          } else {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.google.failed", Date.now() - googleStart, {
              browserOpId,
              browserSession: lane.browserTarget.sessionName,
              browserLane: lane.laneType,
              cloneId: lane.cloneId,
              queryHash,
              failureCode: "navigation.open_failed",
            });
          }

          console.log(`[browser] ${JSON.stringify({
            event: "web_search.fallback",
            browserOpId,
            browserSession: lane.browserTarget.sessionName,
            browserLane: lane.laneType,
            cloneId: lane.cloneId,
            from: "google",
            to: "duckduckgo",
            queryHash,
            queryLength,
          })}`);
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.fallback", 0, {
            browserOpId,
            browserSession: lane.browserTarget.sessionName,
            browserLane: lane.laneType,
            cloneId: lane.cloneId,
            from: "google",
            to: "duckduckgo",
            queryHash,
          });

          const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          const ddgStart = Date.now();
          const ddgOpen = await ab(["open", ddgUrl], undefined, commandOptions);
          if (!ddgOpen.ok) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.duckduckgo.failed", Date.now() - ddgStart, {
              browserOpId,
              browserSession: lane.browserTarget.sessionName,
              browserLane: lane.laneType,
              cloneId: lane.cloneId,
              queryHash,
              failureCode: "search.ddg_failed",
            });
            return { error: "Failed to open search engine" };
          }

          const ddgWait = await ab(["wait", "--load", "networkidle"], undefined, commandOptions);
          if (!ddgWait.ok) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.duckduckgo.failed", Date.now() - ddgStart, {
              browserOpId,
              browserSession: lane.browserTarget.sessionName,
              browserLane: lane.laneType,
              cloneId: lane.cloneId,
              queryHash,
              failureCode: "navigation.wait_networkidle_timeout",
            });
            return { error: `Failed to wait for DuckDuckGo results: ${ddgWait.output.slice(0, 200)}` };
          }

          const snapshot = await takeSnapshot(undefined, commandOptions);
          const ddgDuration = Date.now() - ddgStart;
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.duckduckgo", ddgDuration, {
            browserOpId,
            browserSession: lane.browserTarget.sessionName,
            browserLane: lane.laneType,
            cloneId: lane.cloneId,
            queryHash,
            success: snapshot.ok,
          });

          if (!snapshot.ok) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.duckduckgo.failed", ddgDuration, {
              browserOpId,
              browserSession: lane.browserTarget.sessionName,
              browserLane: lane.laneType,
              cloneId: lane.cloneId,
              queryHash,
              failureCode: "extraction.snapshot_failed",
            });
            return { error: `Failed to capture results: ${snapshot.output.slice(0, 200)}` };
          }

          source = "duckduckgo";
          success = true;
          return {
            source,
            query,
            url: ddgUrl,
            snapshot: snapshot.output,
          };
        };

        try {
          attemptedClone = true;
          try {
            const cloneResult = await withCloneBrowserLane(ctx.copilotHome, ctx.telemetryStore, {
              browserOpId,
              toolName: "web_search",
              queryHash,
            }, runFlow);
            if (!isToolErrorResult(cloneResult)) {
              return cloneResult;
            }
            fallbackToPrimary = true;
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.clone.fallback_to_primary", 0, {
              browserOpId,
              toolName: "web_search",
              queryHash,
              reason: "tool_error",
            });
          } catch (err) {
            fallbackToPrimary = true;
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.clone.fallback_to_primary", 0, {
              browserOpId,
              toolName: "web_search",
              queryHash,
              reason: "exception",
              error: err instanceof Error ? err.message : String(err),
            });
          }

          return await withPrimaryBrowserLane(ctx.copilotHome, ctx.telemetryStore, {
            browserOpId,
            toolName: "web_search",
            queryHash,
          }, runFlow);
        } catch (err: any) {
          return { error: `Search failed: ${String(err).slice(0, 200)}` };
        } finally {
          const duration = Date.now() - toolStart;
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search", duration, {
            browserOpId,
            browserSession,
            success,
            source,
            queryHash,
            queryLength,
            browserLane: laneType,
            attemptedClone,
            fallbackToPrimary,
          });
          if (!success) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.web_search.failed", duration, {
              browserOpId,
              browserSession,
              queryHash,
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
