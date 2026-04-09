// Web search tool — uses agent-browser to search Google (with DuckDuckGo fallback).
// Returns an accessibility-tree snapshot of the results page for the LLM to interpret,
// avoiding fragile CSS selectors that break when search engines change their DOM.

import { defineTool } from "@github/copilot-sdk";
import { run, ab } from "./agent-browser.js";

/** Take a scoped accessibility snapshot of the results area */
async function takeSnapshot(selector?: string): Promise<{ ok: boolean; output: string }> {
  const scope = selector ? ` -s "${selector}"` : "";
  return ab(`snapshot -i${scope}`);
}

/** Check if snapshot contains meaningful search results */
function hasResults(snapshot: string): boolean {
  // A valid results snapshot will have multiple links with headings
  const linkCount = (snapshot.match(/^- link /gm) || []).length;
  const headingCount = (snapshot.match(/heading /gm) || []).length;
  return linkCount >= 3 && headingCount >= 2;
}

export const WEB_SEARCH_TOOLS = [
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
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 5)",
        },
      },
      required: ["query"],
    },
    handler: async (args: any) => {
      const query: string = args.query;

      const check = await run("which agent-browser");
      if (!check.ok) {
        return {
          error:
            "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
        };
      }

      try {
        // Try Google first
        const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const googleOpen = await ab(`open "${googleUrl}"`);

        if (googleOpen.ok) {
          await ab("wait --load networkidle");
          // Scoped snapshot of results area — avoids nav/footer noise
          const snapshot = await takeSnapshot("#rso");

          if (snapshot.ok && hasResults(snapshot.output)) {
            return {
              source: "google",
              query,
              url: googleUrl,
              snapshot: snapshot.output,
            };
          }
        }

        // Fallback to DuckDuckGo
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const ddgOpen = await ab(`open "${ddgUrl}"`);

        if (!ddgOpen.ok) {
          return { error: "Failed to open search engine" };
        }

        await ab("wait --load networkidle");
        const snapshot = await takeSnapshot();

        if (!snapshot.ok) {
          return { error: `Failed to capture results: ${snapshot.output.slice(0, 200)}` };
        }

        return {
          source: "duckduckgo",
          query,
          url: ddgUrl,
          snapshot: snapshot.output,
        };
      } catch (err: any) {
        return { error: `Search failed: ${String(err).slice(0, 200)}` };
      }
    },
  }),
];
